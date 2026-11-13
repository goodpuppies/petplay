import React from "react";
import * as THREE from "three";
import { PivotHandles } from "@react-three/handle";
import { defaultApply, type HandleState } from "@pmndrs/handle";
import {
  connectControllerControl,
  type ControllerHand,
  type ControllerSnapshot,
  controllerTrackingPose,
} from "../openVrControllerControl.ts";
import { penHandler } from "./penEvents.ts";

/** Mount under the raw tracking-space origin. The socket is an explicit opt-in. */
export function ControllerPoseGizmos({ socket }: { socket: string }) {
  const [snapshot, setSnapshot] = React.useState<ControllerSnapshot | null>(null);
  const [selected, setSelected] = React.useState<ControllerHand>("right");
  const connection = React.useRef<Awaited<ReturnType<typeof connectControllerControl>> | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let disposed = false;
    void connectControllerControl(socket).then(async (client) => {
      if (disposed) {
        await client.close();
        return;
      }
      connection.current = client;
      const initial = await client.state();
      if (disposed) return;
      if (!initial.hands.some((hand) => hand.active)) {
        throw Error("The driver has no active synthetic controllers");
      }
      setSnapshot({ ...initial, hands: initial.hands.filter((hand) => hand.active) });
    }).catch((error) => {
      console.warn("[controller-gizmos]", error);
      if (!disposed) {
        setError(String(error));
      }
    });
    return () => {
      disposed = true;
      const client = connection.current;
      connection.current = null;
      void client?.close().catch(console.warn);
    };
  }, [socket]);
  const apply = React.useCallback(
    (hand: ControllerHand, state: HandleState<unknown>, target: THREE.Object3D) => {
      defaultApply(state, target);
      // DesktopControlScene currently uses raw OpenVR tracking coordinates (identity origin).
      const pose = controllerTrackingPose(target);
      void connection.current?.writer.set(hand, pose).catch((error) => {
        console.warn("[controller-gizmos] pose update", error);
        setError(String(error));
      });
    },
    [],
  );
  if (error || !snapshot) return null;
  return (
    <group name="controller-pose-controls" userData={{ desktopControl: true }}>
      {snapshot.hands.map((hand) => {
        const q = hand.pose.qRotation;
        return (
          <PivotHandles
            key={hand.role}
            name={`controller-gizmo-${hand.role}`}
            position={hand.pose.vecPosition}
            quaternion={[q.x, q.y, q.z, q.w]}
            hidden={selected !== hand.role}
            disabled={selected !== hand.role}
            scale={false}
            size={0.25}
            fixed={false}
            apply={(state, target) => apply(hand.role, state, target)}
          >
            <mesh
              name={`controller-proxy-${hand.role}`}
              onPointerDown={penHandler((event) => {
                event.stopPropagation();
                setSelected(hand.role);
              })}
            >
              <boxGeometry args={[0.065, 0.1, 0.12]} />
              <meshBasicMaterial color={hand.role === "left" ? 0x57aaff : 0xffa65a} />
            </mesh>
            <mesh position={[0, 0, -0.1]}>
              <boxGeometry args={[0.012, 0.012, 0.12]} />
              <meshBasicMaterial color={0xffffff} />
            </mesh>
          </PivotHandles>
        );
      })}
    </group>
  );
}
