// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { OBB } from "three/addons/math/OBB.js";
import type { WorkspaceOutput, WorkspaceRect } from "./workspaceDisplays.ts";

export type SpatialNodeId = string;
export type SpatialAttachmentSide = "left" | "right" | "top" | "bottom";

export type SpatialTransform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

export type HingeConstraint = {
  kind: "hinge";
  attachmentSlotId: string;
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
  workspaceOutputConnected?: boolean;
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
  side: SpatialAttachmentSide;
  accepts: Array<SpatialNode["kind"]>;
  attachments: Partial<
    Record<SpatialNode["kind"], {
      kind: "hinge";
      axis: HingeConstraint["axis"];
      angle: number;
      limits: [number, number];
      parentPivot: [number, number, number];
    }>
  >;
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
const DISPLAY_HEIGHT = 0.5;
const DISPLAY_VERTICAL_EDGE = 0.285;
const DISPLAY_SNAP_SIZE: [number, number, number] = [
  DISPLAY_CENTER_DISTANCE,
  DISPLAY_HEIGHT,
  0.04,
];

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
  const snapSource: BoxSnapSource = {
    shape: "box",
    size: [0.5, keyboardHeight, 0.04],
    localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
  };
  const bottomSlot = graph.hitboxes[`${displayId}-bottom-slot`];
  if (bottomSlot == null) return;
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
    constraint: hingeConstraintForSlot(
      bottomSlot,
      "keyboard",
      snapSource.size,
      [keyboardScale, keyboardScale, keyboardScale],
    ),
    snapSource,
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
  addDisplayAttachmentSlots(graph, rootId);
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
    addDisplayAttachmentSlots(graph, id);
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
      ? withoutWorkspaceOutput(display)
      : withWorkspaceOutput(display, output);
  }
  return graph;
}

export function initializeWorkspaceLayoutOutputs(
  current: SpatialGraph,
  outputs: WorkspaceOutput[],
  restoredLayout: boolean,
): SpatialGraph {
  if (restoredLayout) return reconcileWorkspaceOutputs(current, outputs);

  let graph = ensureDefaultSpatialContent(current);
  let displays = displayNodesByOrdinal(graph);
  while (displays.length < outputs.length) {
    const parent = displays.at(-1);
    if (parent == null) break;
    const expanded = spawnHingedDisplay(graph, parent.id);
    if (expanded === graph) break;
    graph = expanded;
    displays = displayNodesByOrdinal(graph);
  }
  return assignWorkspaceOutputs(graph, outputs);
}

export function reconcileWorkspaceOutputs(
  current: SpatialGraph,
  outputs: WorkspaceOutput[],
): SpatialGraph {
  const byId = new Map(outputs.map((output) => [output.id, output]));
  const graph = cloneGraph(current);
  for (const node of Object.values(graph.nodes)) {
    if (node.kind !== "display" || node.workspaceOutputId == null) continue;
    const output = byId.get(node.workspaceOutputId);
    graph.nodes[node.id] = output == null
      ? withDisconnectedWorkspaceOutput(node)
      : withWorkspaceOutput(node, output);
  }
  return graph;
}

export function assignWorkspaceOutput(
  current: SpatialGraph,
  displayId: SpatialNodeId,
  outputId: string,
  outputs: WorkspaceOutput[],
): SpatialGraph {
  const target = current.nodes[displayId];
  const output = outputs.find((candidate) => candidate.id === outputId);
  if (target?.kind !== "display" || output == null) return current;
  if (target.workspaceOutputId === outputId) return reconcileWorkspaceOutputs(current, outputs);

  const graph = cloneGraph(current);
  const previousOutput = outputs.find((candidate) => candidate.id === target.workspaceOutputId);
  const previousOwner = Object.values(graph.nodes).find((node): node is DisplaySpatialNode =>
    node.kind === "display" && node.workspaceOutputId === outputId
  );
  graph.nodes[target.id] = withWorkspaceOutput(target, output);
  if (previousOwner != null && previousOwner.id !== target.id) {
    graph.nodes[previousOwner.id] = previousOutput == null
      ? withoutWorkspaceOutput(previousOwner)
      : withWorkspaceOutput(previousOwner, previousOutput);
  }
  return graph;
}

export function spawnDisplayForWorkspaceOutput(
  current: SpatialGraph,
  output: WorkspaceOutput,
): SpatialGraph {
  if (
    Object.values(current.nodes).some((node) =>
      node.kind === "display" && node.workspaceOutputId === output.id
    )
  ) return current;

  let graph = current;
  let displays = displayNodesByOrdinal(graph);
  graph = displays.length === 0
    ? ensureDefaultSpatialContent(graph)
    : spawnHingedDisplay(graph, displays.at(-1)!.id);
  displays = displayNodesByOrdinal(graph);
  const created = displays.at(-1);
  return created == null ? graph : assignWorkspaceOutput(graph, created.id, output.id, [output]);
}

function displayNodesByOrdinal(graph: SpatialGraph): DisplaySpatialNode[] {
  return Object.values(graph.nodes)
    .filter((node): node is DisplaySpatialNode => node.kind === "display")
    .sort((a, b) => a.ordinal - b.ordinal);
}

function withWorkspaceOutput(
  display: DisplaySpatialNode,
  output: WorkspaceOutput,
): DisplaySpatialNode {
  return {
    ...display,
    workspaceCrop: output.crop,
    workspaceOutputId: output.id,
    workspaceOutputName: output.name,
    workspaceOutputConnected: true,
  };
}

function withDisconnectedWorkspaceOutput(display: DisplaySpatialNode): DisplaySpatialNode {
  return {
    ...display,
    workspaceCrop: undefined,
    workspaceOutputConnected: false,
  };
}

function withoutWorkspaceOutput(display: DisplaySpatialNode): DisplaySpatialNode {
  return {
    ...display,
    workspaceCrop: undefined,
    workspaceOutputId: undefined,
    workspaceOutputName: undefined,
    workspaceOutputConnected: undefined,
  };
}

function addDisplayAttachmentSlots(graph: SpatialGraph, displayId: SpatialNodeId): void {
  const sideSpecs: Array<{
    side: SpatialAttachmentSide;
    size: [number, number, number];
    hitboxPosition: [number, number, number];
    parentPivot: [number, number, number];
    axis: HingeConstraint["axis"];
  }> = [
    {
      side: "left",
      size: [0.18, 0.55, 0.18],
      hitboxPosition: [-DISPLAY_EDGE, 0, 0.025],
      parentPivot: [-DISPLAY_EDGE, 0, 0],
      axis: "y",
    },
    {
      side: "right",
      size: [0.18, 0.55, 0.18],
      hitboxPosition: [DISPLAY_EDGE, 0, 0.025],
      parentPivot: [DISPLAY_EDGE, 0, 0],
      axis: "y",
    },
    {
      side: "top",
      size: [0.55, 0.14, 0.18],
      hitboxPosition: [0, DISPLAY_VERTICAL_EDGE + 0.055, 0.025],
      parentPivot: [0, DISPLAY_VERTICAL_EDGE, 0.025],
      axis: "x",
    },
    {
      side: "bottom",
      size: [0.55, 0.14, 0.18],
      hitboxPosition: [0, -DISPLAY_VERTICAL_EDGE - 0.055, 0.025],
      parentPivot: [0, -DISPLAY_VERTICAL_EDGE, 0.025],
      axis: "x",
    },
  ];
  for (const spec of sideSpecs) {
    const id = `${displayId}-${spec.side}-slot`;
    const displayAttachment = {
      kind: "hinge" as const,
      axis: spec.axis,
      angle: 0,
      limits: [
        THREE.MathUtils.degToRad(-75),
        THREE.MathUtils.degToRad(75),
      ] as [number, number],
      parentPivot: spec.parentPivot,
    };
    graph.hitboxes[id] = {
      id,
      ownerId: displayId,
      side: spec.side,
      shape: "box",
      size: spec.size,
      localTransform: transform(spec.hitboxPosition),
      accepts: spec.side === "bottom" ? ["display", "keyboard"] : ["display"],
      attachments: spec.side === "bottom"
        ? {
          display: displayAttachment,
          keyboard: {
            kind: "hinge",
            axis: "x",
            angle: THREE.MathUtils.degToRad(-55),
            limits: [THREE.MathUtils.degToRad(-100), THREE.MathUtils.degToRad(15)],
            parentPivot: spec.parentPivot,
          },
        }
        : { display: displayAttachment },
    };
  }
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
  // Legacy graph-authored 3D controls are removed in favor of the selected
  // GrabBox's UIKit contextual toolbar.
  removeControls(graph, () => true);
  return graph;
}

export function spawnHingedDisplay(
  current: SpatialGraph,
  parentId: SpatialNodeId,
  preferredSide?: SpatialAttachmentSide,
): SpatialGraph {
  const parent = current.nodes[parentId];
  if (parent?.kind !== "display") return current;

  const graph = cloneGraph(current);
  const sideOrder: SpatialAttachmentSide[] = preferredSide == null
    ? ["right", "left", "top", "bottom"]
    : [preferredSide];
  const slot = sideOrder
    .map((side) => graph.hitboxes[`${parentId}-${side}-slot`])
    .find((candidate) =>
      candidate?.accepts.includes("display") && !isAttachmentSlotOccupied(graph, candidate.id)
    );
  if (slot == null) return current;

  const ordinal = graph.nextDisplayOrdinal++;
  const id = `display-${ordinal}`;
  const display: DisplaySpatialNode = {
    id,
    kind: "display",
    ordinal,
    parentId,
    originId: parent.originId,
    localTransform: { ...IDENTITY_SPATIAL_TRANSFORM },
    onParentDelete: "preserve",
    constraint: hingeConstraintForSlot(slot, "display", DISPLAY_SNAP_SIZE, [1, 1, 1]),
  };
  graph.nodes[id] = display;

  addDisplayAttachmentSlots(graph, id);

  return reconcileDisplayControls(graph);
}

export function spawnHingedDisplayWithAutomaticOutput(
  current: SpatialGraph,
  parentId: SpatialNodeId,
  outputs: WorkspaceOutput[],
  preferredSide?: SpatialAttachmentSide,
): SpatialGraph {
  const assignedOutputIds = new Set(
    Object.values(current.nodes)
      .filter((node): node is DisplaySpatialNode => node.kind === "display")
      .map((display) => display.workspaceOutputId)
      .filter((id): id is string => id != null),
  );
  const unusedOutput = outputs.find((output) => !assignedOutputIds.has(output.id));
  const existingNodeIds = new Set(Object.keys(current.nodes));
  const graph = spawnHingedDisplay(current, parentId, preferredSide);
  if (graph === current || unusedOutput == null) return graph;

  const created = displayNodesByOrdinal(graph).find((display) => !existingNodeIds.has(display.id));
  return created == null
    ? graph
    : assignWorkspaceOutput(graph, created.id, unusedOutput.id, outputs);
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

/** Commit a completed free manipulation and adopt the closest overlapping attachment slot. */
export function commitSpatialNodeTransformAndSnap(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
  localTransform: SpatialTransform,
): SpatialGraph {
  return snapNodeToOverlappingHitbox(
    commitNodeTransform(current, nodeId, localTransform),
    nodeId,
  );
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

function displayAttachmentSlots(graph: SpatialGraph, displayId: SpatialNodeId): SpatialHitbox[] {
  return Object.values(graph.hitboxes).filter((hitbox) => hitbox.ownerId === displayId);
}

export function hasAvailableDisplayAttachmentSlot(
  graph: SpatialGraph,
  displayId: SpatialNodeId,
): boolean {
  return displayAttachmentSlots(graph, displayId).some((slot) =>
    slot.accepts.includes("display") && !isAttachmentSlotOccupied(graph, slot.id)
  );
}

function isAttachmentSlotOccupied(graph: SpatialGraph, slotId: string): boolean {
  return Object.values(graph.nodes).some((node) =>
    node.constraint?.kind === "hinge" && node.constraint.attachmentSlotId === slotId
  );
}

function nodeSnapSource(node: DisplaySpatialNode | KeyboardSpatialNode): BoxSnapSource {
  return node.kind === "keyboard" ? node.snapSource : {
    shape: "box",
    size: DISPLAY_SNAP_SIZE,
    localTransform: IDENTITY_SPATIAL_TRANSFORM,
  };
}

function childPivotForSlot(
  side: SpatialAttachmentSide,
  size: [number, number, number],
  scale: [number, number, number],
): [number, number, number] {
  const halfWidth = 0.5 * size[0] * scale[0];
  const halfHeight = 0.5 * size[1] * scale[1];
  switch (side) {
    case "left":
      return [halfWidth, 0, 0];
    case "right":
      return [-halfWidth, 0, 0];
    case "top":
      return [0, -halfHeight, 0];
    case "bottom":
      return [0, halfHeight, 0];
  }
}

function hingeConstraintForSlot(
  slot: SpatialHitbox,
  childKind: DisplaySpatialNode["kind"] | KeyboardSpatialNode["kind"],
  childSize: [number, number, number],
  childScale: [number, number, number],
): HingeConstraint {
  const attachment = slot.attachments[childKind];
  if (attachment == null) throw new Error(`Slot ${slot.id} does not accept ${childKind}`);
  return {
    kind: "hinge",
    attachmentSlotId: slot.id,
    axis: attachment.axis,
    angle: attachment.angle,
    limits: attachment.limits,
    parentPivot: attachment.parentPivot,
    childPivot: childPivotForSlot(slot.side, childSize, childScale),
  };
}

export function attachSpatialNodeToSlot(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
  slotId: string,
): SpatialGraph {
  const node = current.nodes[nodeId];
  const slot = current.hitboxes[slotId];
  const owner = slot && current.nodes[slot.ownerId];
  if (
    (node?.kind !== "keyboard" && node?.kind !== "display") ||
    node.constraint != null ||
    slot == null ||
    owner == null ||
    !slot.accepts.includes(node.kind) ||
    isAttachmentSlotOccupied(current, slot.id) ||
    slot.ownerId === node.id ||
    isSpatialDescendant(current, slot.ownerId, node.id)
  ) return current;

  const snapSource = nodeSnapSource(node);
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = {
    ...node,
    parentId: slot.ownerId,
    originId: owner.originId,
    localTransform: transform([0, 0, 0], [0, 0, 0], node.localTransform.scale),
    constraint: hingeConstraintForSlot(
      slot,
      node.kind,
      snapSource.size,
      node.localTransform.scale,
    ),
  };
  return reconcileDisplayControls(graph);
}

export function snapNodeToOverlappingHitbox(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if ((node?.kind !== "keyboard" && node?.kind !== "display") || node.constraint != null) {
    return current;
  }
  const snapSource = nodeSnapSource(node);
  const sourceMatrix = getSpatialNodeWorldMatrix(current, nodeId)
    .multiply(composeTransform(snapSource.localTransform));
  const sourceBox = orientedBoxFromMatrix(snapSource.size, sourceMatrix);
  const sourceCenter = sourceBox.center;
  const candidates = Object.values(current.hitboxes)
    .filter((hitbox) => hitbox.accepts.includes(node.kind))
    .filter((hitbox) => hitbox.ownerId !== node.id)
    .filter((hitbox) => !isAttachmentSlotOccupied(current, hitbox.id))
    .filter((hitbox) => !isSpatialDescendant(current, hitbox.ownerId, node.id))
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
  return hitbox == null ? current : attachSpatialNodeToSlot(current, nodeId, hitbox.id);
}

function isSpatialDescendant(
  graph: SpatialGraph,
  candidateId: SpatialNodeId,
  ancestorId: SpatialNodeId,
): boolean {
  let current = graph.nodes[candidateId];
  while (current?.parentId != null) {
    if (current.parentId === ancestorId) return true;
    current = graph.nodes[current.parentId];
  }
  return false;
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

/**
 * Detach the display edge represented by a selected hierarchy node.
 * Attached parents move their complete subtree to root; root parents release
 * their direct display children. Non-display children remain owned normally.
 */
export function detachDisplayHierarchy(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node?.kind !== "display") return current;
  if (node.parentId != null) return detachFromParent(current, nodeId);

  const displayChildren = getSpatialChildren(current, nodeId)
    .filter((child): child is DisplaySpatialNode => child.kind === "display");
  return displayChildren.reduce(
    (graph, child) => detachFromParent(graph, child.id),
    current,
  );
}

export function resetSpatialNodeTransform(
  current: SpatialGraph,
  nodeId: SpatialNodeId,
): SpatialGraph {
  const node = current.nodes[nodeId];
  if (node == null || node.kind === "control") return current;
  const graph = cloneGraph(current);
  graph.nodes[nodeId] = node.constraint?.kind === "hinge"
    ? { ...node, constraint: { ...node.constraint, angle: 0 } }
    : {
      ...node,
      localTransform: {
        position: node.localTransform.position,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    };
  return graph;
}

export function getDisplayAttachmentRole(
  graph: SpatialGraph,
  nodeId: SpatialNodeId,
): DisplayAttachmentRole | null {
  const node = graph.nodes[nodeId];
  if (node?.kind !== "display") return null;
  if (getSpatialChildren(graph, nodeId).some((child) => child.kind === "display")) {
    return "parent";
  }
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
