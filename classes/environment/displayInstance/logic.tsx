import React, { useRef, useState } from "react";
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
import { playspaceFrame } from "../../playspaceFrame.ts";
import { DisplayInstanceFrame, type DisplayInstanceFrameProps } from "./ui.tsx";
import { DEFAULT_DISPLAY_HEIGHT, DISPLAY_ASPECT_WIDTH_OVER_HEIGHT } from "../displayMetrics.ts";
import type { WorkspaceRect } from "../workspaceDisplays.ts";
import { getHeadObject } from "../trackedOrigins.ts";
import { getControllerDeviceFrame, registerDisplaySync } from "../controllerDeviceFrames.ts";
import type { RenderTrackingFollow } from "../../overlayRenderTracking.ts";
import { angleBetweenDeg, nextAutoHidden, stepAutoHideFade } from "./autoHide.ts";

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
  /** Overlay alpha, 0..1 (default opaque). */
  opacity?: number;
  /** Overlay curvature (OpenVR `SetOverlayCurvature`), 0 = flat. */
  curvature?: number;
  /** Fade out, and stop taking rays, while the head is turned away (see `autoHide.ts`). */
  autoHide?: boolean;
  /** Transform target for this display's GrabBox; defaults to the display itself. */
  manipulationTargetRef?: React.RefObject<THREE.Object3D | null>;
  /** Optional constraint/apply policy for the Handle targeting this display. */
  manipulationOptions?: Omit<HandleOptions<unknown>, "filter">;
  manipulationStoreRef?: React.Ref<HandleStore<unknown>>;
  onSpatialFocus?: () => void;
  onSpatialHoverChange?: (hovered: boolean) => void;
  onDismiss?: () => void;
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

const followPoseInverse = new THREE.Matrix4();
const deviceToPose = new THREE.Matrix4();

/**
 * While a controller carries the window (`renderTrackingFollow`), rewrites `world` into that
 * controller's device frame and returns the device index, so the overlay host attaches the screen
 * to the device and the compositor moves it with the controller, as the renderer does the frame.
 */
function carryOnController(obj: THREE.Object3D, world: THREE.Matrix4): number | undefined {
  for (let node: THREE.Object3D | null = obj; node; node = node.parent) {
    const follow = node.userData?.renderTrackingFollow as RenderTrackingFollow | undefined;
    if (follow == null) continue;
    // An overlay attaches to one device; a two-hand carry keeps the screen absolute.
    if (!follow.active() || follow.pair) return undefined;
    const frame = getControllerDeviceFrame(follow.space);
    if (frame == null) return undefined;
    followPoseInverse.copy(follow.pose as unknown as THREE.Matrix4).invert();
    world.premultiply(followPoseInverse).premultiply(
      deviceToPose.fromArray(frame.deviceToPose as number[]),
    );
    return frame.deviceIndex;
  }
  return undefined;
}

/**
 * Wireframe display frame at the picture's aspect, with XR handle: move/rotate and uniform scale (aspect preserved).
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
    opacity = 1,
    curvature = 0,
    autoHide = false,
    manipulationTargetRef,
    manipulationOptions,
    manipulationStoreRef,
    onSpatialFocus,
    onSpatialHoverChange,
    onDismiss,
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
  const lastSentOpacity = useRef<number | null>(null);
  const lastSentCurvature = useRef<number | null>(null);
  const lastSentDevice = useRef<number | undefined>(undefined);
  /** Last crop sent to the overlay host, compared field-wise to avoid a per-frame JSON.stringify. */
  const lastSentCrop = useRef<WorkspaceRect | null>(null);
  /** Auto-hide: 1 shown, 0 faded out; multiplies the opacity sent to the overlay. */
  const autoHideFactor = useRef(1);
  const autoHidden = useRef(false);
  const autoHideHead = useRef(new THREE.Vector3());
  const autoHideFacing = useRef(new THREE.Vector3());
  /** Mirrors `autoHidden` for rendering; only changes when the window hides or comes back. */
  const [raysOff, setRaysOff] = useState(false);

  const height = frameProps.height ?? DEFAULT_DISPLAY_HEIGHT;
  const aspect = frameProps.aspect ?? DISPLAY_ASPECT_WIDTH_OVER_HEIGHT;
  const localHalfW = 0.5 * height * aspect;

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
    // A new feed/provider must receive the pose even if the display itself did not move.
    lastSentHmd.current = null;
    lastSentWidth.current = null;
  }, [displayOverlayHostActor, virtualDisplayId]);

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

  useFrame((state, delta) => {
    const obj = handleRef.current;
    let hidden = false;
    if (autoHide && obj != null) {
      const head = getHeadObject(state.gl, state.camera as THREE.Camera);
      head.updateWorldMatrix(true, false);
      obj.updateWorldMatrix(true, false);
      // Both look down -Z: the head where it looks, the window away from its viewer.
      autoHideHead.current.set(0, 0, -1).transformDirection(head.matrixWorld);
      autoHideFacing.current.set(0, 0, -1).transformDirection(obj.matrixWorld);
      hidden = nextAutoHidden(
        autoHidden.current,
        angleBetweenDeg(autoHideHead.current, autoHideFacing.current),
      );
    }
    autoHideFactor.current = stepAutoHideFade(autoHideFactor.current, hidden, delta);
    if (obj != null) obj.userData.autoHideFactor = autoHideFactor.current;
    if (hidden !== autoHidden.current) {
      autoHidden.current = hidden;
      setRaysOff(hidden);
    }
  });

  // Also run right after a carried window lands, so its screen lets go of the controller at once.
  const syncOverlay = useRef<() => void>(() => {});
  syncOverlay.current = () => {
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
    const deviceIndex = carryOnController(obj, rigidWorld.current);
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
    // Absolute poses go out in PetPlay's playspace frame (raw tracking once anchored), so a
    // playspace drag leaves the screen where it is; controller-relative ones need nothing.
    const rawUniverse = deviceIndex == null && playspaceFrame.active;
    if (rawUniverse) playspaceFrame.poseRowsToUniverse(hmd.m as number[][]);
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
    const sentOpacity = opacity * autoHideFactor.current;
    if (lastSentHmd.current && lastSentWidth.current !== null) {
      if (
        hmd34ApproxEqual(hmd, lastSentHmd.current) &&
        Math.abs(lastSentWidth.current - widthMeters) < 0.0001 &&
        lastSentOpacity.current === sentOpacity &&
        lastSentCurvature.current === curvature &&
        lastSentDevice.current === deviceIndex &&
        cropUnchanged
      ) {
        return;
      }
    }
    lastSentHmd.current = hmd;
    lastSentWidth.current = widthMeters;
    lastSentOpacity.current = sentOpacity;
    lastSentCurvature.current = curvature;
    lastSentDevice.current = deviceIndex;
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
              opacity: sentOpacity,
              curvature,
              deviceIndex,
              rawUniverse,
            },
          }
          : {
            target: targetActor,
            type: "SYNCDISPLAYPOSE",
            payload: {
              hmd,
              widthMeters,
              opacity: sentOpacity,
              curvature,
              deviceIndex,
              rawUniverse,
            },
          },
      );
    } catch {
      // actor may be torn down
    }
  };
  React.useEffect(() => registerDisplaySync(() => syncOverlay.current()), []);
  useFrame(() => syncOverlay.current(), displaySyncFrameOpts);

  return (
    <group
      position={position}
      rotation={rotation}
      userData={{
        displayInstance: true,
        aspect,
        displayOverlayHostActor: displayOverlayHostActor ?? null,
      }}
    >
      <DisplayInstanceFrame
        ref={handleRef}
        {...frameProps}
        videoFeed={frameProps.videoFeed && workspaceCrop
          ? { ...frameProps.videoFeed, crop: workspaceCrop, opacity }
          : null}
        {...(raysOff ? { rayHitSurface: false, shellRayPickable: false, onMouse: undefined } : {})}
        curvature={curvature}
        manipulationTargetRef={manipulationTargetRef}
        manipulationOptions={manipulationOptions}
        manipulationStoreRef={manipulationStoreRef}
        onSpatialFocus={onSpatialFocus}
        onSpatialHoverChange={onSpatialHoverChange}
        onDismiss={onDismiss}
      />
    </group>
  );
}
