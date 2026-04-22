import * as THREE from "three";
import type { InstancedBufferAttribute, Material, Object3D } from "three";
import {
  type OrderInfo,
  orderInfoKey,
} from "../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/order.ts";

export type WebXRRaythreeUiOrderInfo = {
  majorIndex: number;
  minorIndex: number;
  elementType: number;
  patchIndex: number;
};

export type WebXRRaythreeUiPanelSnapshot = {
  worldMatrix: Float32Array;
  data: Float32Array;
  clipping: Float32Array;
  instanceIndex: number;
  renderOrder: number;
  depthTest: boolean;
  depthWrite: boolean;
  orderInfo?: WebXRRaythreeUiOrderInfo;
};

export type WebXRRaythreeUiTextSnapshot = {
  worldMatrix: Float32Array;
  text: string;
  color: [number, number, number, number];
  fontSize: number;
  align: "left" | "center" | "right";
  anchorX: "left" | "center" | "right";
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  /** Per-glyph quad geometry in mesh-local space (from MSDFTextGeometry). */
  geometry?: {
    positions: Float32Array; // itemSize=2
    uvs: Float32Array; // itemSize=2
    indices: Uint16Array | Uint32Array;
    version: number;
  };
};

export type WebXRRaythreeUiSnapshot = {
  panels: WebXRRaythreeUiPanelSnapshot[];
  texts: WebXRRaythreeUiTextSnapshot[];
};

export type WebXRRaythreeTextUserData = {
  text: string;
  color: [number, number, number, number];
  fontSize: number;
  align: "left" | "center" | "right";
  anchorX: "left" | "center" | "right";
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
};

const DEFAULT_CLIPPING = new Float32Array([
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
  -1e6,
]);
const matrixHelper = new THREE.Matrix4();
const instanceMatrixHelper = new THREE.Matrix4();

export function extractWebXRRaythreeUi(scene: THREE.Scene): WebXRRaythreeUiSnapshot {
  const snapshot: WebXRRaythreeUiSnapshot = {
    panels: [],
    texts: [],
  };

  scene.traverseVisible((object: Object3D) => {
    maybeCollectPanels(object, snapshot.panels);
    maybeCollectText(object, snapshot.texts);
  });

  return snapshot;
}

function maybeCollectPanels(
  object: Object3D,
  target: WebXRRaythreeUiPanelSnapshot[],
): void {
  const count = readPanelInstanceCount(object);
  if (count <= 0) {
    return;
  }

  const geometry = (object as Object3D & {
    geometry?: {
      attributes?: Record<string, InstancedBufferAttribute | undefined>;
    };
  }).geometry;
  const material = (object as Object3D & {
    material?: Material & { depthTest?: boolean; depthWrite?: boolean };
    renderOrder?: number;
  }).material;
  const instanceMatrix = geometry?.attributes?.instanceMatrix ??
    (object as Object3D & { instanceMatrix?: InstancedBufferAttribute }).instanceMatrix;
  const instanceData = geometry?.attributes?.aData;
  if (instanceMatrix == null || instanceData == null) {
    return;
  }

  const instanceClipping = geometry?.attributes?.aClipping;
  const renderOrder = Number((object as Object3D & { renderOrder?: number }).renderOrder ?? 0);
  const depthTest = material?.depthTest ?? true;
  const depthWrite = material?.depthWrite ?? false;
  const orderInfo = readOrderInfo(object);

  for (let index = 0; index < count; index++) {
    const matrixOffset = index * 16;
    const dataOffset = index * 16;
    matrixHelper.fromArray(object.matrixWorld.elements);
    instanceMatrixHelper.fromArray(
      Array.from(instanceMatrix.array.slice(matrixOffset, matrixOffset + 16)),
    );
    matrixHelper.multiply(instanceMatrixHelper);
    target.push({
      worldMatrix: new Float32Array(matrixHelper.elements),
      data: new Float32Array(instanceData.array.slice(dataOffset, dataOffset + 16)),
      clipping: instanceClipping == null
        ? new Float32Array(DEFAULT_CLIPPING)
        : new Float32Array(instanceClipping.array.slice(dataOffset, dataOffset + 16)),
      instanceIndex: index,
      renderOrder,
      depthTest,
      depthWrite,
      orderInfo,
    });
  }
}

function maybeCollectText(
  object: Object3D,
  target: WebXRRaythreeUiTextSnapshot[],
): void {
  const metadata = (object.userData as {
    raythreeUiText?: WebXRRaythreeTextUserData;
  } | undefined)?.raythreeUiText;
  if (metadata == null) {
    return;
  }
  const meshGeometry = (object as Object3D & {
    geometry?: {
      attributes?: {
        position?: { array: ArrayLike<number>; itemSize: number; version?: number };
        uv?: { array: ArrayLike<number>; itemSize: number };
      };
      index?: { array: ArrayLike<number>; version?: number } | null;
    };
  }).geometry;
  let geometry: WebXRRaythreeUiTextSnapshot["geometry"];
  const positionAttr = meshGeometry?.attributes?.position;
  const uvAttr = meshGeometry?.attributes?.uv;
  const indexAttr = meshGeometry?.index;
  if (positionAttr != null && uvAttr != null && indexAttr != null) {
    const rawIndices = indexAttr.array;
    const indices = rawIndices instanceof Uint16Array || rawIndices instanceof Uint32Array
      ? rawIndices
      : new Uint32Array(Array.from(rawIndices as ArrayLike<number>));
    geometry = {
      positions: positionAttr.array instanceof Float32Array
        ? positionAttr.array
        : Float32Array.from(positionAttr.array as ArrayLike<number>),
      uvs: uvAttr.array instanceof Float32Array
        ? uvAttr.array
        : Float32Array.from(uvAttr.array as ArrayLike<number>),
      indices,
      version: Number(indexAttr.version ?? 0) + Number(positionAttr.version ?? 0),
    };
  }
  target.push({
    worldMatrix: new Float32Array(object.matrixWorld.elements),
    text: metadata.text,
    color: metadata.color,
    fontSize: metadata.fontSize,
    align: metadata.align,
    anchorX: metadata.anchorX,
    bounds: metadata.bounds,
    geometry,
  });
}

function readPanelInstanceCount(object: Object3D): number {
  const candidate = object as Object3D & {
    count?: number;
    geometry?: {
      attributes?: Record<string, InstancedBufferAttribute | undefined>;
    };
  };
  const hasPanelAttributes = candidate.geometry?.attributes?.aData !== undefined &&
    candidate.geometry?.attributes?.aData0 !== undefined &&
    candidate.geometry?.attributes?.aClipping !== undefined;
  if (!hasPanelAttributes) {
    return 0;
  }
  return Math.max(0, Number(candidate.count ?? 0));
}

function readOrderInfo(object: Object3D): WebXRRaythreeUiOrderInfo | undefined {
  const signal = (object as Object3D & {
    [orderInfoKey]?: { value?: OrderInfo | undefined };
  })[orderInfoKey];
  const value = signal?.value;
  if (value == null) {
    return undefined;
  }
  return {
    majorIndex: value.majorIndex,
    minorIndex: value.minorIndex,
    elementType: value.elementType,
    patchIndex: value.patchIndex,
  };
}
