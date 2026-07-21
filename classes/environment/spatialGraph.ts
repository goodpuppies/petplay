// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { OBB } from "three/addons/math/OBB.js";

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

type SpatialNodeBase = {
  id: SpatialNodeId;
  parentId: SpatialNodeId | null;
  originId: string;
  localTransform: SpatialTransform;
  constraint?: SpatialConstraint;
};

export type BoxSnapSource = {
  shape: "box";
  size: [number, number, number];
  localTransform: SpatialTransform;
};

export type DisplaySpatialNode = SpatialNodeBase & {
  kind: "display";
  ordinal: number;
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
    action,
    targetId,
  };
  return id;
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
  };
  addDisplayBottomHitbox(graph, rootId);
  addControl(graph, rootId, "spawn-display", rootId, [0.53, 0, 0.025]);
  graph.nodes.keyboard = {
    id: "keyboard",
    kind: "keyboard",
    parentId: null,
    originId: "scene-origin",
    localTransform: transform(
      [0.45, -0.8, 0.03],
      [0, -0.38, 0],
      [0.38, 0.38, 0.38],
    ),
    snapSource: {
      shape: "box",
      size: [0.5, 0.2, 0.04],
      localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
    },
  };
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

export function spawnHingedDisplay(
  current: SpatialGraph,
  parentId: SpatialNodeId,
): SpatialGraph {
  const parent = current.nodes[parentId];
  if (parent?.kind !== "display") return current;

  const graph = cloneGraph(current);
  removeControls(
    graph,
    (node) => node.action === "spawn-display" && node.parentId === parentId,
  );

  const ordinal = graph.nextDisplayOrdinal++;
  const id = `display-${ordinal}`;
  graph.nodes[id] = {
    id,
    kind: "display",
    ordinal,
    parentId,
    originId: parent.originId,
    localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
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

  addControl(graph, id, "spawn-display", id, [0.53, 0, 0.025]);
  addControl(graph, id, "release-hinge", id, [-0.4, -0.34, 0.025]);
  return graph;
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
  for (const control of Object.values(graph.nodes)) {
    if (
      control.kind === "control" && control.action === "release-hinge" &&
      control.targetId === nodeId
    ) {
      graph.nodes[control.id] = { ...control, action: "detach" };
    }
  }
  return graph;
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
  removeControls(
    graph,
    (control) => control.action === "detach" && control.targetId === nodeId,
  );
  return graph;
}

export function getSpatialChildren(
  graph: SpatialGraph,
  parentId: SpatialNodeId | null,
): SpatialNode[] {
  return Object.values(graph.nodes).filter((node) => node.parentId === parentId);
}
