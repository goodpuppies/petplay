export type ShadowSceneMeshKind = "torus" | "cube";

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
    {
      kind: "cube",
      position: [0.35, 1.2, -1.45],
      rotation: [0, 0, 0],
      scale: [0.18, 0.18, 0.18],
      color: [84, 214, 44, 220],
      wireColor: [160, 255, 132, 255],
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

export function getWebXRShadowSceneSnapshot(): WebXRShadowSceneSnapshot {
  return {
    background: [...shadowSceneState.background] as [number, number, number, number],
    floorColor: [...shadowSceneState.floorColor] as [number, number, number, number],
    gridColor: [...shadowSceneState.gridColor] as [number, number, number, number],
    meshes: shadowSceneState.meshes.map(cloneMesh),
  };
}
