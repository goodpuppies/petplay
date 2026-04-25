export type ShadowSceneMeshKind = "torus";

export type ShadowSceneMesh = {
  kind: ShadowSceneMeshKind;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: [number, number, number, number];
  wireColor?: [number, number, number, number];
};

export type WebXRShadowSceneSnapshot = {
  background: [number, number, number, number];
  floorColor: [number, number, number, number];
  gridColor: [number, number, number, number];
  meshes: ShadowSceneMesh[];
};

export type WebXRShadowRenderPayload = {
  frame: {
    frameCount: number;
    eyeWidth: number;
    eyeHeight: number;
    outputWidth: number;
    outputHeight: number;
    lookRotation: Float32Array;
    viewerPosition: Float32Array;
    viewerQuaternion: Float32Array;
    leftEyePosition: Float32Array;
    leftEyeQuaternion: Float32Array;
    leftEyeViewMatrix: Float32Array;
    leftEyeProjectionMatrix: Float32Array;
    rightEyePosition: Float32Array;
    rightEyeQuaternion: Float32Array;
    rightEyeViewMatrix: Float32Array;
    rightEyeProjectionMatrix: Float32Array;
    halfFovInRadians: number;
    ipdMeters: number;
  };
  scene: WebXRShadowSceneSnapshot;
};

const shadowSceneState: WebXRShadowSceneSnapshot = {
  background: [0, 0, 0, 0],
  floorColor: [18, 30, 42, 96],
  gridColor: [46, 61, 80, 72],
  meshes: [
    {
      kind: "torus",
      position: [0, 1.45, -1.8],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: [255, 139, 61, 255],
      wireColor: [255, 196, 148, 255],
    },
  ],
};

function cloneMesh(mesh: ShadowSceneMesh): ShadowSceneMesh {
  return {
    kind: mesh.kind,
    position: [...mesh.position] as [number, number, number],
    rotation: [...mesh.rotation] as [number, number, number],
    scale: [...mesh.scale] as [number, number, number],
    color: [...mesh.color] as [number, number, number, number],
    wireColor: mesh.wireColor
      ? [...mesh.wireColor] as [number, number, number, number]
      : undefined,
  };
}

export function updateShadowSceneMesh(
  index: number,
  update: Partial<Omit<ShadowSceneMesh, "kind">> & Pick<ShadowSceneMesh, "kind">,
) {
  const existing = shadowSceneState.meshes[index];
  if (!existing) {
    shadowSceneState.meshes[index] = cloneMesh({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      color: [255, 255, 255, 255],
      ...update,
    });
    return;
  }

  shadowSceneState.meshes[index] = {
    ...existing,
    ...update,
    position: update.position ? [...update.position] as [number, number, number] : existing.position,
    rotation: update.rotation ? [...update.rotation] as [number, number, number] : existing.rotation,
    scale: update.scale ? [...update.scale] as [number, number, number] : existing.scale,
    color: update.color ? [...update.color] as [number, number, number, number] : existing.color,
    wireColor: update.wireColor
      ? [...update.wireColor] as [number, number, number, number]
      : existing.wireColor,
  };
}

// --- VRChat origin tracking ---------------------------------------------
// The VRCOrigin actor publishes an OpenVR HmdMatrix34 (row-major, 3x4) that
// represents the VRChat world origin in SteamVR absolute tracking space.
// We stash it here so the r3f scene can parent VRC-relative objects to it
// when needed.
//
// Matrix layout kept here is a column-major 16-element array so it can be
// fed directly into THREE.Matrix4.fromArray() / Object3D.matrix.fromArray().

const vrcOriginMatrixElements = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
let vrcOriginKnown = false;

export function setVRCOriginFromHmdMatrix34(
  rows: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ],
) {
  // HmdMatrix34 is row-major; THREE.Matrix4.elements is column-major.
  vrcOriginMatrixElements[0] = rows[0][0];
  vrcOriginMatrixElements[1] = rows[1][0];
  vrcOriginMatrixElements[2] = rows[2][0];
  vrcOriginMatrixElements[3] = 0;

  vrcOriginMatrixElements[4] = rows[0][1];
  vrcOriginMatrixElements[5] = rows[1][1];
  vrcOriginMatrixElements[6] = rows[2][1];
  vrcOriginMatrixElements[7] = 0;

  vrcOriginMatrixElements[8] = rows[0][2];
  vrcOriginMatrixElements[9] = rows[1][2];
  vrcOriginMatrixElements[10] = rows[2][2];
  vrcOriginMatrixElements[11] = 0;

  vrcOriginMatrixElements[12] = rows[0][3];
  vrcOriginMatrixElements[13] = rows[1][3];
  vrcOriginMatrixElements[14] = rows[2][3];
  vrcOriginMatrixElements[15] = 1;

  vrcOriginKnown = true;
}

export function getVRCOriginMatrixElements(): Float32Array {
  return vrcOriginMatrixElements;
}

export function isVRCOriginKnown(): boolean {
  return vrcOriginKnown;
}

// --- Controller snapshot ------------------------------------------------
// Populated from webxr.ts every poll using the OpenVR-derived pose/trigger
// data emitted by the `controllers.ts` actor. Stored in SteamVR absolute
// tracking space so the r3f scene can mix them with the VRC origin.

export type ShadowControllerHand = "left" | "right";

type ControllerSnapshotSlot = {
  valid: boolean;
  // Column-major 16-element matrix (SteamVR absolute -> controller grip).
  matrix: Float32Array;
  triggerPressed: boolean;
};

function makeSlot(): ControllerSnapshotSlot {
  return {
    valid: false,
    matrix: new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]),
    triggerPressed: false,
  };
}

const controllerSnapshot: Record<ShadowControllerHand, ControllerSnapshotSlot> = {
  left: makeSlot(),
  right: makeSlot(),
};

function writeMatrixFromRows(
  out: Float32Array,
  rows: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ],
) {
  out[0] = rows[0][0];  out[1] = rows[1][0];  out[2] = rows[2][0];  out[3] = 0;
  out[4] = rows[0][1];  out[5] = rows[1][1];  out[6] = rows[2][1];  out[7] = 0;
  out[8] = rows[0][2];  out[9] = rows[1][2];  out[10] = rows[2][2]; out[11] = 0;
  out[12] = rows[0][3]; out[13] = rows[1][3]; out[14] = rows[2][3]; out[15] = 1;
}

export function setShadowControllerPose(
  hand: ShadowControllerHand,
  rows:
    | [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ]
    | null,
  triggerPressed: boolean,
) {
  const slot = controllerSnapshot[hand];
  if (rows) {
    writeMatrixFromRows(slot.matrix, rows);
    slot.valid = true;
  } else {
    slot.valid = false;
  }
  slot.triggerPressed = triggerPressed;
}

export function getShadowControllerSnapshot(): Readonly<
  Record<ShadowControllerHand, Readonly<ControllerSnapshotSlot>>
> {
  return controllerSnapshot;
}

export function getWebXRShadowSceneSnapshot(): WebXRShadowSceneSnapshot {
  return {
    background: [...shadowSceneState.background] as [number, number, number, number],
    floorColor: [...shadowSceneState.floorColor] as [number, number, number, number],
    gridColor: [...shadowSceneState.gridColor] as [number, number, number, number],
    meshes: shadowSceneState.meshes.map(cloneMesh),
  };
}
