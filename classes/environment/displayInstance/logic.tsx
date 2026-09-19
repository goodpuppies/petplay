import React, { useRef } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import {
  extend,
  type ThreeToJSXElements,
  useFrame,
  type UseFrameNextOptions,
} from "@react-three/fiber/webgpu";
import type { HandleOptions, HandleStore } from "@pmndrs/handle";
import { PostMan } from "../../../submodules/stageforge/mod.ts";
import { hmd34FromColumnMajor4x4 } from "../../openvrTransform.ts";
import {
  DEFAULT_DISPLAY_HEIGHT,
  DISPLAY_ASPECT_WIDTH_OVER_HEIGHT,
  DisplayInstanceFrame,
  type DisplayInstanceFrameProps,
} from "./ui.tsx";
import type { WorkspaceRect } from "../workspaceDisplays.ts";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

declare module "@react-three/fiber/webgpu" {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

export type DisplayInstanceProps = DisplayInstanceFrameProps & {
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Optional actor id for future overlay / bridge correlation. */
  displayOverlayHostActor?: string | null;
  virtualDisplayId?: string;
  workspaceCrop?: WorkspaceRect;
  virtualDisplayName?: string;
  /** Transform target for this display's GrabBox; defaults to the display itself. */
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  /** Optional constraint/apply policy for the Handle targeting this display. */
  manipulationOptions?: Omit<HandleOptions<unknown>, "filter">;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  onSpatialFocus?: () => void;
  onSpatialHoverChange?: (hovered: boolean) => void;
};

export {
  createWindowsSystemDisplayMouseSink,
  releaseWindowsSyntheticDisplayMouseState,
  releaseWindowsSyntheticDisplayMouseStateWithKm,
  windowsSystemDisplayMouseSink,
} from "./mouse.ts";
export type { DisplayMouseLogicEvent, DisplayMouseSink } from "./mouse.ts";

function hmd34ApproxEqual(
  a: { m: number[][] },
  b: { m: number[][] },
  eps: number = 0.0001,
): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      if (Math.abs(a.m[i][j] - b.m[i][j]) > eps) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 16:9 wireframe display frame with XR handle: move/rotate and uniform scale (aspect preserved).
 * When `displayOverlayHostActor` is set, the OpenVR desktop overlay actor is kept aligned with
 * this transform and world width (meters) each frame.
 */
export function DisplayInstance(
  {
    position,
    rotation,
    displayOverlayHostActor,
    virtualDisplayId,
    workspaceCrop,
    virtualDisplayName,
    manipulationTargetRef,
    manipulationOptions,
    manipulationStoreRef,
    onSpatialFocus,
    onSpatialHoverChange,
    ...frameProps
  }: DisplayInstanceProps,
) {
  const handleRef = useRef<THREE.Group | null>(null);
  const p0 = useRef(new THREE.Vector3());
  const p1 = useRef(new THREE.Vector3());
  const decompPos = useRef(new THREE.Vector3());
  const decompQuat = useRef(new THREE.Quaternion());
  const decompScale = useRef(new THREE.Vector3());
  const unitScale = useRef(new THREE.Vector3(1, 1, 1));
  const rigidWorld = useRef(new THREE.Matrix4());
  const lastSentHmd = useRef<ReturnType<typeof hmd34FromColumnMajor4x4> | null>(null);
  const lastSentWidth = useRef<number | null>(null);
  /** Last crop sent to the overlay host, compared field-wise to avoid a per-frame JSON.stringify. */
  const lastSentCrop = useRef<WorkspaceRect | null>(null);

  const height = frameProps.height ?? DEFAULT_DISPLAY_HEIGHT;
  const localHalfW = 0.5 * height * DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;

  const displaySyncFrameOpts = React.useMemo<UseFrameNextOptions>(
    () => ({
      id: `petplay-display-openvr-${virtualDisplayId ?? "legacy"}`,
      enabled: displayOverlayHostActor != null,
      phase: "finish",
      // No `fps` / `drop`: a 60Hz cap (and `drop: true` under load) only re-evaluated this pose
      // 60×/s while XR sim can run 75–200+ Hz, which beats with the HMD/overlay and looks like
      // micro judder. Matrix equality below still limits cross-actor traffic when the pose is flat.
    }),
    [displayOverlayHostActor, virtualDisplayId],
  );

  React.useEffect(() => {
    if (!displayOverlayHostActor || !virtualDisplayId) return;
    return () => {
      try {
        PostMan.PostMessage({
          target: displayOverlayHostActor,
          type: "REMOVEVIRTUALDISPLAY",
          payload: { id: virtualDisplayId },
        });
      } catch {
        // Actor may already be shutting down.
      }
    };
  }, [displayOverlayHostActor, virtualDisplayId]);

  useFrame(() => {
    if (displayOverlayHostActor == null) {
      return;
    }
    const targetActor = displayOverlayHostActor;
    const obj = handleRef.current;
    if (obj == null) {
      return;
    }
    // `false` for children: the display's own pose is all this job needs, and the attached
    // keyboard/keycaps would otherwise have their whole subtree re-composed every frame while the
    // r3f/raylib paths already update world matrices for the frame.
    obj.updateWorldMatrix(true, false);
    // `SetOverlayWidthInMeters` already encodes the physical size. OpenVR expects a
    // rigid 3×4 (rotation + translation); baking scale into 3×3 as well would double-apply
    // size together with the width we send.
    obj.matrixWorld.decompose(
      decompPos.current,
      decompQuat.current,
      decompScale.current,
    );
    rigidWorld.current.compose(decompPos.current, decompQuat.current, unitScale.current);
    const hmd = hmd34FromColumnMajor4x4(
      rigidWorld.current.elements as unknown as {
        0: number;
        4: number;
        8: number;
        12: number;
        1: number;
        5: number;
        9: number;
        13: number;
        2: number;
        6: number;
        10: number;
        14: number;
      },
    );
    p0.current.set(-localHalfW, 0, 0);
    p1.current.set(localHalfW, 0, 0);
    p0.current.applyMatrix4(obj.matrixWorld);
    p1.current.applyMatrix4(obj.matrixWorld);
    const widthMeters = p0.current.distanceTo(p1.current);

    const lastCrop = lastSentCrop.current;
    const cropUnchanged = workspaceCrop == null ? lastCrop == null : lastCrop != null &&
      lastCrop.x === workspaceCrop.x &&
      lastCrop.y === workspaceCrop.y &&
      lastCrop.width === workspaceCrop.width &&
      lastCrop.height === workspaceCrop.height;
    if (lastSentHmd.current && lastSentWidth.current !== null) {
      if (
        hmd34ApproxEqual(hmd, lastSentHmd.current) &&
        Math.abs(lastSentWidth.current - widthMeters) < 0.0001 &&
        cropUnchanged
      ) {
        return;
      }
    }
    lastSentHmd.current = hmd;
    lastSentWidth.current = widthMeters;
    lastSentCrop.current = workspaceCrop ? { ...workspaceCrop } : null;
    try {
      PostMan.PostMessage(
        virtualDisplayId && workspaceCrop
          ? {
            target: targetActor,
            type: "SYNCVIRTUALDISPLAY",
            payload: {
              id: virtualDisplayId,
              name: virtualDisplayName,
              crop: workspaceCrop,
              hmd,
              widthMeters,
            },
          }
          : {
            target: targetActor,
            type: "SYNCDISPLAYPOSE",
            payload: { hmd, widthMeters },
          },
      );
    } catch {
      // actor may be torn down
    }
  }, displaySyncFrameOpts);

  return (
    <group
      position={position}
      rotation={rotation}
      userData={{
        displayInstance: true,
        aspect: "16:9",
        displayOverlayHostActor: displayOverlayHostActor ?? null,
      }}
    >
      <DisplayInstanceFrame
        ref={handleRef}
        {...frameProps}
        manipulationTargetRef={manipulationTargetRef}
        manipulationOptions={manipulationOptions}
        manipulationStoreRef={manipulationStoreRef}
        onSpatialFocus={onSpatialFocus}
        onSpatialHoverChange={onSpatialHoverChange}
      />
    </group>
  );
}
