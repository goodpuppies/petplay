export type Vec3Tuple = [number, number, number];
export type Matrix34Tuple = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

export type VrcCameraDebugPose = {
  position: Vec3Tuple;
  rotationDeg: Vec3Tuple;
  receivedAt: number;
};

export type VrcCameraDebugSnapshot = {
  cameraPose: VrcCameraDebugPose | null;
  relativeCameraPose: VrcCameraDebugPose | null;
  originEstimate: Vec3Tuple | null;
  lookAtTargetEstimate: Vec3Tuple | null;
  legacyOriginMatrix: Matrix34Tuple | null;
};

const snapshot: VrcCameraDebugSnapshot = {
  cameraPose: null,
  relativeCameraPose: null,
  originEstimate: null,
  lookAtTargetEstimate: null,
  legacyOriginMatrix: null,
};

let baselineCameraPosition: Vec3Tuple | null = null;

export function setVrcCameraDebugPose(pose: VrcCameraDebugPose): void {
  snapshot.cameraPose = {
    position: [...pose.position],
    rotationDeg: [...pose.rotationDeg],
    receivedAt: pose.receivedAt,
  };

  if (!baselineCameraPosition) {
    baselineCameraPosition = [...pose.position];
  }

  snapshot.relativeCameraPose = {
    position: [
      pose.position[0] - baselineCameraPosition[0],
      pose.position[1] - baselineCameraPosition[1],
      pose.position[2] - baselineCameraPosition[2],
    ],
    rotationDeg: [...pose.rotationDeg],
    receivedAt: pose.receivedAt,
  };
}

export function setVrcCameraOriginEstimate(position: Vec3Tuple | null): void {
  snapshot.originEstimate = position ? [...position] : null;
}

export function setVrcCameraLookAtTargetEstimate(position: Vec3Tuple | null): void {
  snapshot.lookAtTargetEstimate = position ? [...position] : null;
}

export function setVrcLegacyOriginDebugMatrix(matrix: Matrix34Tuple | null): void {
  snapshot.legacyOriginMatrix = matrix
    ? [
      [...matrix[0]],
      [...matrix[1]],
      [...matrix[2]],
    ]
    : null;
}

export function getVrcCameraDebugSnapshot(): VrcCameraDebugSnapshot {
  return {
    cameraPose: snapshot.cameraPose
      ? {
        position: [...snapshot.cameraPose.position],
        rotationDeg: [...snapshot.cameraPose.rotationDeg],
        receivedAt: snapshot.cameraPose.receivedAt,
      }
      : null,
    relativeCameraPose: snapshot.relativeCameraPose
      ? {
        position: [...snapshot.relativeCameraPose.position],
        rotationDeg: [...snapshot.relativeCameraPose.rotationDeg],
        receivedAt: snapshot.relativeCameraPose.receivedAt,
      }
      : null,
    originEstimate: snapshot.originEstimate ? [...snapshot.originEstimate] : null,
    lookAtTargetEstimate: snapshot.lookAtTargetEstimate ? [...snapshot.lookAtTargetEstimate] : null,
    legacyOriginMatrix: snapshot.legacyOriginMatrix
      ? [
        [...snapshot.legacyOriginMatrix[0]],
        [...snapshot.legacyOriginMatrix[1]],
        [...snapshot.legacyOriginMatrix[2]],
      ]
      : null,
  };
}
