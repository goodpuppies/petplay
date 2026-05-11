import { Pointer, type RayPointerOptions } from "@pmndrs/pointer-events";
import {
  CombinedPointer,
  defaultRayPointerOpacity,
  DefaultXRControllerGrabPointer,
  type DefaultXRControllerOptions,
  type DefaultXRInputSourceGrabPointerOptions,
  type DefaultXRInputSourceRayPointerOptions,
  DefaultXRInputSourceTeleportPointer,
  PointerCursorModel,
  usePointerXRInputSourceEvents,
  useRayPointer,
  useXRInputSourceStateContext,
  XRControllerModel,
  XRSpace,
} from "@pmndrs/xr";
import { useFrame } from "@react-three/fiber/webgpu";
import React, { forwardRef, Suspense, useImperativeHandle, useMemo, useRef } from "react";
import { MeshBasicMaterial, Object3D } from "three/webgpu";
import { HandPoker } from "./handPoker.tsx";
import { useControllerLaserEnabled } from "./controllerLaserMode.ts";

function spreadable<T>(value: true | T | undefined): T | undefined {
  if (value === true || value === undefined) {
    return undefined;
  }
  return value;
}

type HudRayColor = number | string | readonly [number, number, number];

type HudRayModelOptions = {
  renderOrder?: number;
  color?: HudRayColor | ((pointer: Pointer) => HudRayColor);
  opacity?: number | ((pointer: Pointer) => number);
  maxLength?: number;
  size?: number;
};

/** Match [ConstantControllerAimBeam](controllerAimBeam.tsx); options can override via `rayPointer.rayModel`. */
const PETPLAY_RAY_DEFAULTS: Pick<
  HudRayModelOptions,
  "maxLength" | "size" | "color" | "renderOrder"
> = {
  maxLength: 0.15,
  size: 0.002,
  color: 0x5ec8ff,
  renderOrder: 9999,
};

const EXTENDED_RAY_MAX_LENGTH = 0.95;

type AimSegmentObject = {
  visible: boolean;
  position: { z: number };
  scale: { set: (x: number, y: number, z: number) => void };
  updateMatrix: () => void;
};

function updateHudRayModel(
  mesh: AimSegmentObject,
  material: MeshBasicMaterial,
  pointer: Pointer,
  options: HudRayModelOptions,
) {
  if (!pointer.getEnabled()) {
    mesh.visible = false;
    return;
  }
  const intersection = pointer.getIntersection();
  const color = typeof options.color === "function" ? options.color(pointer) : options.color;
  if (Array.isArray(color)) {
    material.color.set(color[0]!, color[1]!, color[2]!);
  } else if (color == null) {
    material.color.set(0xffffff);
  } else if (typeof color === "number") {
    material.color.setHex(color);
  } else {
    material.color.set(String(color));
  }
  material.opacity = typeof options.opacity === "function"
    ? options.opacity(pointer)
    : (options.opacity ?? 0.4);

  mesh.visible = true;

  // Check if pointing at interactive elements (keyboard, etc.)
  const isPointingAtInteractive = intersection?.object?.userData?.keyboard === true ||
    intersection?.object?.userData?.handPoker === true ||
    intersection?.object?.userData?.wristMenuActor != null;

  // Use extended length when pointing at interactive elements
  const maxLen = isPointingAtInteractive ? EXTENDED_RAY_MAX_LENGTH : (options.maxLength ?? 0.15);

  const length = intersection == null ? maxLen : Math.min(maxLen, intersection.distance);
  mesh.position.z = -length / 2;
  const size = options.size ?? 0.005;
  mesh.scale.set(size, size, length);
  mesh.updateMatrix();
}

const HudPointerRayModel = forwardRef<Object3D, HudRayModelOptions & { pointer: Pointer }>(
  (props, ref) => {
    const material = useMemo(
      () =>
        new MeshBasicMaterial({
          transparent: true,
          toneMapped: false,
          depthTest: true,
          depthWrite: false,
        }),
      [],
    );
    const internalRef = useRef<Object3D>(null);
    useImperativeHandle(ref, () => internalRef.current!);
    useFrame(() => {
      if (internalRef.current != null) {
        updateHudRayModel(
          internalRef.current as unknown as AimSegmentObject,
          material,
          props.pointer,
          props,
        );
      }
    });
    return (
      <mesh
        matrixAutoUpdate={false}
        renderOrder={props.renderOrder ?? 2}
        ref={internalRef}
        material={material as never}
        userData={{ raythreeHudOverUi: true }}
        {...({ pointerEvents: "none" } as Record<string, unknown>)}
      >
        <boxGeometry />
      </mesh>
    );
  },
);

function PetplayDefaultXRInputSourceRayPointer(props: DefaultXRInputSourceRayPointerOptions) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useRayPointer(ref, state, props);
  usePointerXRInputSourceEvents(pointer, state.inputSource, "select", state.events);
  const rayModelOptions = props.rayModel;
  const cursorModelOptions = props.cursorModel;
  const rayOpts = spreadable(rayModelOptions);
  return (
    <XRSpace ref={ref} space="target-ray-space">
      {rayModelOptions !== false && (
        <HudPointerRayModel
          pointer={pointer}
          {...PETPLAY_RAY_DEFAULTS}
          opacity={1}
          {...rayOpts}
        />
      )}
      {cursorModelOptions != null && cursorModelOptions !== false && (
        <PointerCursorModel
          pointer={pointer}
          opacity={defaultRayPointerOpacity}
          {...spreadable(cursorModelOptions)}
        />
      )}
    </XRSpace>
  );
}

/** Squeeze + target-ray, `pointerType: "grab"`. Paired with `DefaultXRControllerGrabPointer` in `CombinedPointer`. */
function PetplayGrabRayPointer(
  { ...rayOpts }: RayPointerOptions,
) {
  const state = useXRInputSourceStateContext();
  const ref = useRef<Object3D>(null);
  const pointer = useRayPointer(ref, state, rayOpts, "grab");
  usePointerXRInputSourceEvents(pointer, state.inputSource, "squeeze", state.events);
  return <XRSpace ref={ref} space="target-ray-space" />;
}

/**
 * Hit-capped aim beam, select ray, teleport, and both grip-sphere and laser grab on squeeze.
 * Inner `CombinedPointer` picks one active grab (sphere when in range, else aim-ray grab).
 */
export function PetplayDefaultXRController(props: DefaultXRControllerOptions) {
  const modelOptions = props.model;
  const grabPointerOptions = props.grabPointer;
  const rayPointerOptions = props.rayPointer;
  const teleportPointerOptions = props.teleportPointer ?? false;
  const laserEnabled = useControllerLaserEnabled();

  const rayP = (spreadable(rayPointerOptions) ?? {}) as DefaultXRInputSourceRayPointerOptions;
  const grabO = (spreadable(grabPointerOptions) ?? {}) as DefaultXRInputSourceGrabPointerOptions;
  const grabPointerProps: DefaultXRInputSourceGrabPointerOptions = {
    cursorModel: false,
    ...grabO,
  };
  const minD = rayP.minDistance ?? 0.2;
  const {
    cursorModel: _gcm,
    radius: _gr,
    makeDefault: _gmd,
    ...grabForRay
  } = grabO;
  void _gcm;
  void _gr;
  void _gmd;

  return (
    <>
      {/* <HandPoker /> */}
      {modelOptions !== false && (
        <Suspense>
          <XRControllerModel {...spreadable(modelOptions)} />
        </Suspense>
      )}
      {grabPointerOptions !== false && (
        <CombinedPointer>
          <DefaultXRControllerGrabPointer {...grabPointerProps} />
          {laserEnabled && (
            <PetplayGrabRayPointer
              {...(grabForRay as RayPointerOptions)}
              minDistance={minD}
            />
          )}
        </CombinedPointer>
      )}
      {rayPointerOptions !== false && laserEnabled && (
        <PetplayDefaultXRInputSourceRayPointer
          {...rayP}
          makeDefault
          minDistance={minD}
        />
      )}
      {teleportPointerOptions !== false && (
        <DefaultXRInputSourceTeleportPointer {...spreadable(teleportPointerOptions)} />
      )}
    </>
  );
}
