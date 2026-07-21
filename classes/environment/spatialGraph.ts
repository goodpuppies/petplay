// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { OBB } from "three/addons/math/OBB.js";
import type { WorkspaceOutput, WorkspaceRect } from "./workspaceDisplays.ts";

export type SpatialNodeId = string;

export type SpatialTransform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

export type HingeConstraint = {
  kind: "hinge";
  axis: "x" | "y" | "z";
  angle: number;
  limits: [number, number];
  parentPivot: [number, number, number];
  childPivot: [number, number, number];
};

export type SpatialConstraint = HingeConstraint;

export type ParentDeleteBehavior = "preserve" | "cascade";
export type DisplayAttachmentRole = "solo" | "parent" | "child";

type SpatialNodeBase = {
  id: SpatialNodeId;
  parentId: SpatialNodeId | null;
  originId: string;
  localTransform: SpatialTransform;
  constraint?: SpatialConstraint;
  onParentDelete: ParentDeleteBehavior;
};

export type BoxSnapSource = {
  shape: "box";
  size: [number, number, number];
  localTransform: SpatialTransform;
};

export type DisplaySpatialNode = SpatialNodeBase & {
  kind: "display";
  ordinal: number;
  /** Crop of the shared Full Workspace capture presented by this display. */
  workspaceCrop?: WorkspaceRect;
  workspaceOutputId?: string;
  workspaceOutputName?: string;
};

export type KeyboardSpatialNode = SpatialNodeBase & {
  kind: "keyboard";
  snapSource: BoxSnapSource;
};

export type SpatialControlAction = "spawn-display" | "release-hinge" | "detach";

export type ControlSpatialNode = SpatialNodeBase & {
  kind: "control";
  action: SpatialControlAction;
  targetId: SpatialNodeId;
};

export type SpatialNode = DisplaySpatialNode | KeyboardSpatialNode | ControlSpatialNode;

export type BoxSnapHitbox = {
  id: string;
  ownerId: SpatialNodeId;
  shape: "box";
  size: [number, number, number];
  localTransform: SpatialTransform;
  accepts: Array<SpatialNode["kind"]>;
  attachment: {
    kind: "hinge";
    axis: HingeConstraint["axis"];
    angle: number;
    limits: [number, number];
    parentPivot: [number, number, number];
  };
};

export type SpatialHitbox = BoxSnapHitbox;

export type SpatialGraph = {
  nodes: Record<SpatialNodeId, SpatialNode>;
  hitboxes: Record<string, SpatialHitbox>;
  nextDisplayOrdinal: number;
  nextControlOrdinal: number;
};

export const IDENTITY_SPATIAL_TRANSFORM: SpatialTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const DISPLAY_CENTER_DISTANCE = 1.04;
const DISPLAY_EDGE = DISPLAY_CENTER_DISTANCE / 2;

function transform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): SpatialTransform {
  return { position, rotation, scale };
}

function addControl(
  graph: SpatialGraph,
  parentId: SpatialNodeId,
  action: SpatialControlAction,
  targetId: SpatialNodeId,
  position: [number, number, number],
): SpatialNodeId {
  const id = `control-${graph.nextControlOrdinal++}`;
  graph.nodes[id] = {
    id,
    kind: "control",
    parentId,
    originId: graph.nodes[parentId].originId,
    localTransform: transform(position),
    onParentDelete: "cascade",
    action,
    targetId,
  };
  return id;
}

function addDefaultKeyboard(graph: SpatialGraph, displayId: SpatialNodeId): void {
  const display = graph.nodes[displayId];
  if (display?.kind !== "display") return;
  const keyboardScale = 0.38;
  const keyboardHeight = 0.2;
  graph.nodes.keyboard = {
    id: "keyboard",
    kind: "keyboard",
    parentId: displayId,
    originId: display.originId,
    localTransform: transform([0, 0, 0], [0, 0, 0], [
      keyboardScale,
      keyboardScale,
      keyboardScale,
    ]),
    onParentDelete: "preserve",
    constraint: {
      kind: "hinge",
      axis: "x",
      angle: THREE.MathUtils.degToRad(-55),
      limits: [THREE.MathUtils.degToRad(-100), THREE.MathUtils.degToRad(15)],
      parentPivot: [0, -0.285, 0.025],
      childPivot: [0, 0.5 * keyboardHeight * keyboardScale, 0],
    },
    snapSource: {
      shape: "box",
      size: [0.5, keyboardHeight, 0.04],
      localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
    },
  };
}

export function createInitialSpatialGraph(): SpatialGraph {
  const graph: SpatialGraph = {
    nodes: {},
    hitboxes: {},
    nextDisplayOrdinal: 2,
    nextControlOrdinal: 1,
  };
  const rootId = "display-1";
  graph.nodes[rootId] = {
    id: rootId,
    kind: "display",
    ordinal: 1,
    parentId: null,
    originId: "scene-origin",
    localTransform: transform([0, 0, 0]),
    onParentDelete: "preserve",
  };
  addDisplayBottomHitbox(graph, rootId);
  addDefaultKeyboard(graph, rootId);
  return reconcileDisplayControls(graph);
}

export function ensureDefaultSpatialContent(current: SpatialGraph): SpatialGraph {
  const hasDisplay = Object.values(current.nodes).some((node) => node.kind === "display");
  const hasKeyboard = Object.values(current.nodes).some((node) => node.kind === "keyboard");
  if (hasDisplay && hasKeyboard) return current;

  const graph = cloneGraph(current);
  if (!hasDisplay) {
    const ordinal = graph.nextDisplayOrdinal++;
    const id = `display-${ordinal}`;
    graph.nodes[id] = {
      id,
      kind: "display",
      ordinal,
      parentId: null,
      originId: "scene-origin",
      localTransform: transform([0, 0, 0]),
      onParentDelete: "preserve",
    };
    addDisplayBottomHitbox(graph, id);
  }
  if (!hasKeyboard) {
    const primaryDisplay = Object.values(graph.nodes)
      .filter((node): node is DisplaySpatialNode =>
        node.kind === "display" && node.parentId == null
      )
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    if (primaryDisplay != null) addDefaultKeyboard(graph, primaryDisplay.id);
  }
  return reconcileDisplayControls(graph);
}

/** Assign physical KDE outputs to spatial displays without creating captures. */
export function assignWorkspaceOutputs(
  current: SpatialGraph,
  outputs: WorkspaceOutput[],
): SpatialGraph {
  if (outputs.length === 0) return current;
  const graph = cloneGraph(current);
  const displays = Object.values(graph.nodes)
    .filter((node): node is DisplaySpatialNode => node.kind === "display")
    .sort((a, b) => a.ordinal - b.ordinal);
  for (const [index, display] of displays.entries()) {
    const output = outputs[index];
    graph.nodes[display.id] = output == null
      ? {
        ...display,
        workspaceCrop: undefined,
        workspaceOutputId: undefined,
        workspaceOutputName: undefined,
      }
      : {
        ...display,
        workspaceCrop: output.crop,
        workspaceOutputId: output.id,
        workspaceOutputName: output.name,
      };
  }
  return graph;
}

function addDisplayBottomHitbox(graph: SpatialGraph, displayId: SpatialNodeId): void {
  const id = `${displayId}-bottom-snap`;
  graph.hitboxes[id] = {
    id,
    ownerId: displayId,
    shape: "box",
    size: [0.55, 0.14, 0.18],
    localTransform: transform([0, -0.34, 0.025]),
    accepts: ["keyboard"],
    attachment: {
      kind: "hinge",
      axis: "x",
      angle: THREE.MathUtils.degToRad(-55),
      limits: [THREE.MathUtils.degToRad(-100), THREE.MathUtils.degToRad(15)],
      parentPivot: [0, -0.285, 0.025],
    },
  };
}

function cloneGraph(graph: SpatialGraph): SpatialGraph {
  return {
    nodes: { ...graph.nodes },
    hitboxes: { ...graph.hitboxes },
    nextDisplayOrdinal: graph.nextDisplayOrdinal,
    nextControlOrdinal: graph.nextControlOrdinal,
  };
}

function removeControls(
  graph: SpatialGraph,
  predicate: (node: ControlSpatialNode) => boolean,
): void {
  for (const node of Object.values(graph.nodes)) {
    if (node.kind === "control" && predicate(node)) {
      delete graph.nodes[node.id];
    }
  }
}

function reconcileDisplayControls(current: SpatialGraph): SpatialGraph {
  const graph = cloneGraph(current);
  removeControls(graph, () => true);
  const displays = Object.values(graph.nodes)
    .filter((node): node is DisplaySpatialNode => node.kind === "display")
    .sort((a, b) => a.ordinal - b.ordinal);
  for (const display of displays) {
    const hasDisplayChild = displays.some((candidate) => candidate.parentId === display.id);
    if (!hasDisplayChild) {
      addControl(graph, display.id, "spawn-display", display.id, [0.53, 0, 0.025]);
    }
    if (display.parentId == null) continue;
    addControl(
      graph,
      display.id,
      display.constraint?.kind === "hinge" ? "release-hinge" : "detach",
      display.id,
      [-0.4, -0.34, 0.025],
    );
  }
  return graph;
}

export function spawnHingedDisplay(
  current: SpatialGraph,
  parentId: SpatialNodeId,
): SpatialGraph {
  const parent = current.nodes[parentId];
  if (parent?.kind !== "display") return current;

  const graph = cloneGraph(current);

  const ordinal = graph.nextDisplayOrdinal++;
  const id = `display-${ordinal}`;
  graph.nodes[id] = {
    id,
    kind: "display",
    ordinal,
    parentId,
    originId: parent.originId,
    localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
    onParentDelete: "preserve",
    constraint: {
      kind: "hinge",
      axis: "y",
      angle: 0,
      limits: [THREE.MathUtils.degToRad(-75), THREE.MathUtils.degToRad(75)],
      parentPivot: [DISPLAY_EDGE, 0, 0],
      childPivot: [-DISPLAY_EDGE, 0, 0],
    },
  };

  addDisplayBottomHitbox(graph, id);

  return reconcileDisplayControls(graph);
}

export function setHingeAngle(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
  angle: number,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node?.constraint?.kind !== "hinge") return current;
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = {
    ...node,
    constraint: {
      ...node.constraint,
      angle: THREE.MathUtils.clamp(angle, node.constraint.limits[0], node.constraint.limits[1]),
    },
  };
  return graph;
}

function composeTransform(value: SpatialTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...value.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...value.rotation, "XYZ")),
    new THREE.Vector3(...value.scale),
  );
}

function decomposeTransform(matrix: THREE.Matrix4): SpatialTransform {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const rotation = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    position: position.toArray() as [number, number, number],
    rotation: [rotation.x, rotation.y, rotation.z],
    scale: scale.toArray() as [number, number, number],
  };
}

export function getEffectiveLocalMatrix(node: SpatialNode): THREE.Matrix4 {
  const local = composeTransform(node.localTransform);
  if (node.constraint?.kind !== "hinge") return local;
  const hinge = node.constraint;
  const axis = hinge.axis === "x"
    ? new THREE.Vector3(1, 0, 0)
    : hinge.axis === "y"
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  return new THREE.Matrix4()
    .makeTranslation(...hinge.parentPivot)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, hinge.angle))
    .multiply(new THREE.Matrix4().makeTranslation(
      -hinge.childPivot[0],
      -hinge.childPivot[1],
      -hinge.childPivot[2],
    ))
    .multiply(local);
}

export function getSpatialNodeWorldMatrix(
  graph: SpatialGraph,
  nodeId: SpatialNodeId,
): THREE.Matrix4 {
  const node = graph.nodes[nodeId];
  if (!node) return new THREE.Matrix4();
  const local = getEffectiveLocalMatrix(node);
  return node.parentId == null
    ? local
    : getSpatialNodeWorldMatrix(graph, node.parentId).multiply(local);
}

export function commitNodeTransform(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
  localTransform: SpatialTransform,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (!node || node.constraint) return current;
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = { ...node, localTransform };
  return graph;
}

export function updateSnapSourceSize(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
  size: [number, number, number],
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node?.kind !== "keyboard") return current;
  if (node.snapSource.size.every((value, index) => Math.abs(value - size[index]) < 0.0001)) {
    return current;
  }
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = {
    ...node,
    snapSource: { ...node.snapSource, size },
  };
  return graph;
}

function orientedBoxFromMatrix(
  size: [number, number, number],
  matrix: THREE.Matrix4,
): OBB {
  const half = new THREE.Vector3(...size).multiplyScalar(0.5);
  return new OBB(
    new THREE.Vector3() as never,
    half as never,
    new THREE.Matrix3() as never,
  ).applyMatrix4(matrix as never);
}

export function getSpatialHitboxWorldMatrix(
  graph: SpatialGraph,
  hitbox: SpatialHitbox,
): THREE.Matrix4 {
  return getSpatialNodeWorldMatrix(graph, hitbox.ownerId)
    .multiply(composeTransform(hitbox.localTransform));
}

export function snapNodeToOverlappingHitbox(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node?.kind !== "keyboard" || node.constraint != null) return current;
  const sourceMatrix = getSpatialNodeWorldMatrix(current, nodeId)
    .multiply(composeTransform(node.snapSource.localTransform));
  const sourceBox = orientedBoxFromMatrix(node.snapSource.size, sourceMatrix);
  const sourceCenter = sourceBox.center;
  const candidates = Object.values(current.hitboxes)
    .filter((hitbox) => hitbox.accepts.includes(node.kind))
    .filter((hitbox) =>
      sourceBox.intersectsOBB(orientedBoxFromMatrix(
        hitbox.size,
        getSpatialHitboxWorldMatrix(current, hitbox),
      ))
    )
    .sort((a, b) => {
      const aCenter = new THREE.Vector3().setFromMatrixPosition(
        getSpatialHitboxWorldMatrix(current, a),
      );
      const bCenter = new THREE.Vector3().setFromMatrixPosition(
        getSpatialHitboxWorldMatrix(current, b),
      );
      const adx = sourceCenter.x - aCenter.x;
      const ady = sourceCenter.y - aCenter.y;
      const adz = sourceCenter.z - aCenter.z;
      const bdx = sourceCenter.x - bCenter.x;
      const bdy = sourceCenter.y - bCenter.y;
      const bdz = sourceCenter.z - bCenter.z;
      return adx * adx + ady * ady + adz * adz - (bdx * bdx + bdy * bdy + bdz * bdz);
    });
  const hitbox = candidates[0];
  const owner = hitbox && current.nodes[hitbox.ownerId];
  if (!hitbox || !owner) return current;

  const graph = cloneGraph(current);
  const scaledHalfHeight = 0.5 * node.snapSource.size[1] * node.localTransform.scale[1];
  graph.nodes[nodeId] = {
    ...node,
    parentId: hitbox.ownerId,
    originId: owner.originId,
    localTransform: transform([0, 0, 0], [0, 0, 0], node.localTransform.scale),
    constraint: {
      kind: "hinge",
      axis: hitbox.attachment.axis,
      angle: hitbox.attachment.angle,
      limits: hitbox.attachment.limits,
      parentPivot: hitbox.attachment.parentPivot,
      childPivot: [0, scaledHalfHeight, 0],
    },
  };
  return graph;
}

export function releaseHinge(current: SpatialGraph, nodeId: SpatialNodeId): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node?.constraint?.kind !== "hinge") return current;
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = {
    ...node,
    localTransform: decomposeTransform(getEffectiveLocalMatrix(node)),
    constraint: undefined,
  };
  return reconcileDisplayControls(graph);
}

export function detachFromParent(current: SpatialGraph, nodeId: SpatialNodeId): SpatialGraph {
  const node = current.nodes[nodeId];
  if (!node || node.parentId == null) return current;
  const world = getSpatialNodeWorldMatrix(current, nodeId);
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = {
    ...node,
    parentId: null,
    localTransform: decomposeTransform(world),
    constraint: undefined,
  };
  return reconcileDisplayControls(graph);
}

function hasPreservedDescendant(graph: SpatialGraph, nodeId: SpatialNodeId): boolean {
  for (const child of getSpatialChildren(graph, nodeId)) {
    if (child.onParentDelete === "preserve" || hasPreservedDescendant(graph, child.id)) {
      return true;
    }
  }
  return false;
}

export function getDisplayAttachmentRole(
  graph: SpatialGraph,
  nodeId: SpatialNodeId,
): DisplayAttachmentRole | null {
  const node = graph.nodes[nodeId];
  if (node?.kind !== "display") return null;
  if (hasPreservedDescendant(graph, nodeId)) return "parent";
  return node.parentId == null ? "solo" : "child";
}

export function deleteSpatialNode(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (!node || node.kind === "control") return current;

  const graph = cloneGraph(current);
  const deletedIds = new Set<SpatialNodeId>([nodeId]);
  const collectCascadeChildren = (parentId: SpatialNodeId) => {
    for (const child of getSpatialChildren(current, parentId)) {
      if (child.onParentDelete !== "cascade") continue;
      deletedIds.add(child.id);
      collectCascadeChildren(child.id);
    }
  };
  collectCascadeChildren(nodeId);

  const survivingChildren = getSpatialChildren(current, nodeId)
    .filter((child) => child.onParentDelete === "preserve");
  const nextParentId = node.parentId;
  const nextParentWorldInverse = nextParentId == null
    ? null
    : getSpatialNodeWorldMatrix(current, nextParentId).invert();
  for (const child of survivingChildren) {
    const world = getSpatialNodeWorldMatrix(current, child.id);
    const local = nextParentWorldInverse == null
      ? world
      : nextParentWorldInverse.clone().multiply(world);
    graph.nodes[child.id] = {
      ...child,
      parentId: nextParentId,
      originId: node.originId,
      localTransform: decomposeTransform(local),
      constraint: undefined,
    };
  }

  for (const id of deletedIds) delete graph.nodes[id];
  for (const candidate of Object.values(graph.nodes)) {
    if (candidate.kind === "control" && deletedIds.has(candidate.targetId)) {
      delete graph.nodes[candidate.id];
    }
  }
  for (const hitbox of Object.values(graph.hitboxes)) {
    if (deletedIds.has(hitbox.ownerId)) delete graph.hitboxes[hitbox.id];
  }
  return reconcileDisplayControls(graph);
}

export function getSpatialChildren(
  graph: SpatialGraph,
  parentId: SpatialNodeId | null,
): SpatialNode[] {
  return Object.values(graph.nodes).filter((node) => node.parentId === parentId);
}
