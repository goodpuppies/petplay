import {
  assignWorkspaceOutput,
  assignWorkspaceOutputs,
  attachSpatialNodeToSlot,
  commitHingePose,
  commitNodeTransform,
  commitSpatialNodeTransformAndSnap,
  createInitialSpatialGraph,
  deleteSpatialNode,
  detachDisplayHierarchy,
  detachFromParent,
  displayToolbarSide,
  ensureDefaultSpatialContent,
  getDisplayAttachmentRole,
  getSpatialNodeWorldMatrix,
  initializeWorkspaceLayoutOutputs,
  normalizeSpatialLayout,
  recenterSpatialRoots,
  reconcileWorkspaceOutputs,
  releaseHinge,
  resetSpatialNodeTransform,
  setSpatialNodeAutoHide,
  setSpatialNodeCurvature,
  setSpatialNodeLocked,
  setSpatialNodeMouseBlocked,
  setSpatialNodeOpacity,
  setSpatialRootOrigin,
  type SpatialGraph,
  spawnDisplayForWorkspaceOutput,
  spawnHingedDisplay,
  spawnHingedDisplayWithAutomaticOutput,
} from "./spatialGraph.ts";
import { DEFAULT_DISPLAY_HEIGHT, DISPLAY_PANEL_WIDTH } from "./displayMetrics.ts";
import type { WorkspaceOutput } from "./workspaceDisplays.ts";
import * as THREE from "three/webgpu";

const PANEL_HALF_WIDTH = DISPLAY_PANEL_WIDTH / 2;
const PANEL_HALF_HEIGHT = DEFAULT_DISPLAY_HEIGHT / 2;

/** World position of a point given in a node's local frame. */
function worldPointOf(
  graph: SpatialGraph,
  nodeId: string,
  local: [number, number, number],
): THREE.Vector3 {
  // Expanded by hand: `three/webgpu` and `@types/three` resolve `Matrix4` to incompatible types.
  const m = getSpatialNodeWorldMatrix(graph, nodeId).elements;
  const [x, y, z] = local;
  return new THREE.Vector3(
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  );
}

/** Distance between the touching panel edges of a display hinged to `side` of `display-1`. */
function hingeEdgeGap(graph: SpatialGraph, side: "left" | "right" | "top" | "bottom"): number {
  const horizontal = side === "left" || side === "right";
  const positive = side === "right" || side === "top";
  const half = horizontal ? PANEL_HALF_WIDTH : PANEL_HALF_HEIGHT;
  const axis = horizontal ? 0 : 1;
  const parentLocal: [number, number, number] = [0, 0, 0];
  const childLocal: [number, number, number] = [0, 0, 0];
  parentLocal[axis] = positive ? half : -half;
  childLocal[axis] = positive ? -half : half;
  return worldPointOf(graph, "display-1", parentLocal)
    .distanceTo(worldPointOf(graph, "display-2", childLocal));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertMatrixApprox(
  actual: { elements: ArrayLike<number> },
  expected: { elements: ArrayLike<number> },
  message: string,
) {
  for (let index = 0; index < 16; index++) {
    if (Math.abs(actual.elements[index] - expected.elements[index]) > 0.00001) {
      throw new Error(`${message} at matrix element ${index}`);
    }
  }
}

function output(id: string, name = id): WorkspaceOutput {
  return {
    id,
    name,
    priority: 0,
    logicalX: 0,
    logicalY: 0,
    logicalWidth: 1920,
    logicalHeight: 1080,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
}

Deno.test("display roles only describe the display hierarchy", () => {
  const initial = createInitialSpatialGraph();
  assert(
    Object.values(initial.nodes).every((node) => node.kind !== "control"),
    "contextual UIKit replaces graph-authored 3D controls",
  );
  assert(
    getDisplayAttachmentRole(initial, "display-1") === "solo",
    "a keyboard child should not make a display a display parent",
  );

  const chain = spawnHingedDisplay(initial, "display-1");
  assert(getDisplayAttachmentRole(chain, "display-1") === "parent", "root should be parent");
  assert(getDisplayAttachmentRole(chain, "display-2") === "child", "leaf should be child");
});

Deno.test("reparenting a display does not count its keyboard toward display roles", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = detachFromParent(graph, "display-2");
  graph = attachSpatialNodeToSlot(graph, "display-1", "display-2-left-slot");

  assert(
    getDisplayAttachmentRole(graph, "display-2") === "parent",
    "new display owner should be the sole parent",
  );
  assert(
    getDisplayAttachmentRole(graph, "display-1") === "child",
    "reparented display remains a leaf even though it owns a keyboard",
  );
});

Deno.test("detaching a root display parent releases its display children only", () => {
  const attached = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const detached = detachDisplayHierarchy(attached, "display-1");
  const child = detached.nodes["display-2"];
  const keyboard = detached.nodes.keyboard;

  assert(child?.parentId === null && child.constraint == null, "display child moves to root");
  assert(keyboard?.parentId === "display-1", "keyboard ownership remains unchanged");
  assert(getDisplayAttachmentRole(detached, "display-1") === "solo", "parent becomes solo");
  assert(getDisplayAttachmentRole(detached, "display-2") === "solo", "child becomes solo");
});

Deno.test("detaching an attached display parent keeps its subtree together", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = spawnHingedDisplay(graph, "display-2", "right");
  graph = detachDisplayHierarchy(graph, "display-2");

  const parent = graph.nodes["display-2"];
  const child = graph.nodes["display-3"];
  assert(parent?.parentId === null && parent.constraint == null, "selected parent moves to root");
  assert(child?.parentId === "display-2", "its display child remains attached");
  assert(getDisplayAttachmentRole(graph, "display-2") === "parent", "subtree root remains parent");
});

Deno.test("deleting a display restores preserved children and cascades controls", () => {
  const chain = spawnHingedDisplay(createInitialSpatialGraph(), "display-1");
  const childWorldBefore = getSpatialNodeWorldMatrix(chain, "display-2");
  const deleted = deleteSpatialNode(chain, "display-1");
  const child = deleted.nodes["display-2"];

  assert(child?.kind === "display", "child display should survive");
  assert(child.parentId === null, "child display should be promoted to the origin");
  assert(child.constraint == null, "constraint to deleted parent should be removed");
  assert(getDisplayAttachmentRole(deleted, child.id) === "solo", "promoted child should be solo");
  assertMatrixApprox(
    getSpatialNodeWorldMatrix(deleted, child.id),
    childWorldBefore,
    "promoted child should recover its pre-delete world transform",
  );
  assert(
    Object.values(deleted.nodes).every((node) =>
      node.kind !== "control" || node.targetId !== "display-1"
    ),
    "controls targeting the deleted display should be removed",
  );
  assert(
    Object.values(deleted.hitboxes).every((hitbox) => hitbox.ownerId !== "display-1"),
    "deleted display hitboxes should be removed",
  );
});

Deno.test("deleting a monitor cancels inherited scale for an attached keyboard", () => {
  const graph = createInitialSpatialGraph();
  const display = graph.nodes["display-1"];
  const keyboard = graph.nodes.keyboard;
  assert(display?.kind === "display", "display fixture should exist");
  assert(keyboard?.kind === "keyboard", "keyboard fixture should exist");
  graph.nodes[keyboard.id] = {
    ...keyboard,
    parentId: display.id,
    localTransform: { ...keyboard.localTransform, scale: [1, 1, 1] },
    constraint: {
      kind: "hinge",
      attachmentSlotId: "display-1-bottom-slot",
      axis: "x",
      angle: -0.5,
      limits: [-1.5, 0.3],
      parentPivot: [0, -0.285, 0.025],
      childPivot: [0, 0.1, 0],
    },
  };
  const keyboardWorldBefore = getSpatialNodeWorldMatrix(graph, keyboard.id);

  const deleted = deleteSpatialNode(graph, display.id);
  const restoredKeyboard = deleted.nodes[keyboard.id];
  assert(restoredKeyboard?.kind === "keyboard", "keyboard should survive parent deletion");
  assert(restoredKeyboard.parentId === null, "keyboard should be promoted to the origin");
  assert(restoredKeyboard.constraint == null, "deleted monitor hinge should be removed");
  assertMatrixApprox(
    getSpatialNodeWorldMatrix(deleted, keyboard.id),
    keyboardWorldBefore,
    "keyboard should retain its stored pre-gesture world transform",
  );
});

Deno.test("deleting the last content can be recovered explicitly", () => {
  let graph = createInitialSpatialGraph();
  graph = deleteSpatialNode(graph, "keyboard");
  graph = deleteSpatialNode(graph, "display-1");
  assert(Object.values(graph.nodes).every((node) => node.kind === "control"), "content is gone");

  graph = ensureDefaultSpatialContent(graph);
  const display = Object.values(graph.nodes).find((node) => node.kind === "display");
  const keyboard = Object.values(graph.nodes).find((node) => node.kind === "keyboard");
  assert(display?.kind === "display", "display restored");
  assert(keyboard?.kind === "keyboard", "keyboard restored");
  assert(keyboard.parentId === display.id, "restored keyboard should attach to the display");
  assert(keyboard.constraint?.kind === "hinge", "restored keyboard should use its default hinge");
});

Deno.test("assigning an owned workspace output swaps physical outputs between displays", () => {
  const outputs = [output("DP-1"), output("HDMI-1")];
  const initial = spawnHingedDisplay(createInitialSpatialGraph(), "display-1");
  const assigned = assignWorkspaceOutputs(initial, outputs);
  const swapped = assignWorkspaceOutput(assigned, "display-1", "HDMI-1", outputs);
  const first = swapped.nodes["display-1"];
  const second = swapped.nodes["display-2"];
  assert(first?.kind === "display" && first.workspaceOutputId === "HDMI-1", "root swaps");
  assert(second?.kind === "display" && second.workspaceOutputId === "DP-1", "child swaps");
});

Deno.test("workspace reconciliation preserves disconnected assignment identity", () => {
  const outputs = [output("DP-1"), output("HDMI-1")];
  const initial = spawnHingedDisplay(createInitialSpatialGraph(), "display-1");
  const assigned = assignWorkspaceOutput(
    assignWorkspaceOutputs(initial, outputs),
    "display-1",
    "HDMI-1",
    outputs,
  );
  const reconciled = reconcileWorkspaceOutputs(assigned, [output("HDMI-1", "Main panel")]);
  const first = reconciled.nodes["display-1"];
  const second = reconciled.nodes["display-2"];
  assert(
    first?.kind === "display" && first.workspaceOutputName === "Main panel",
    "connected assignment is retained and refreshed",
  );
  assert(
    second?.kind === "display" && second.workspaceOutputId === "DP-1" &&
      second.workspaceOutputConnected === false && second.workspaceCrop == null,
    "disconnected assignment is retained without presenting a stale crop",
  );
});

Deno.test("restored workspace layouts never recreate deleted displays", () => {
  let graph = createInitialSpatialGraph();
  graph = deleteSpatialNode(graph, "keyboard");
  graph = deleteSpatialNode(graph, "display-1");
  const restored = initializeWorkspaceLayoutOutputs(
    graph,
    [output("DP-1"), output("HDMI-1")],
    true,
  );
  assert(
    Object.values(restored.nodes).every((node) => node.kind !== "display"),
    "physical outputs stay available instead of recreating deleted layout nodes",
  );
});

Deno.test("restored layouts saved without any outputs receive them", () => {
  const restored = initializeWorkspaceLayoutOutputs(
    createInitialSpatialGraph(),
    [output("windows-capture")],
    true,
  );
  const display = restored.nodes["display-1"] as import("./spatialGraph.ts").DisplaySpatialNode;
  assert(display.workspaceOutputId === "windows-capture", "the saved display gets the output");
  assert(display.workspaceOutputConnected === true, "the saved display should be connected");
});

Deno.test("first-run workspace layouts bootstrap connected physical outputs", () => {
  const initialized = initializeWorkspaceLayoutOutputs(
    createInitialSpatialGraph(),
    [output("DP-1"), output("HDMI-1")],
    false,
  );
  const displays = Object.values(initialized.nodes)
    .filter((node): node is import("./spatialGraph.ts").DisplaySpatialNode =>
      node.kind === "display"
    );
  assert(displays.length === 2, "first run should create one node per connected output");
  assert(
    displays.every((display) => display.workspaceOutputId != null),
    "first-run nodes should receive physical outputs",
  );
});

Deno.test("adding an unassigned output creates and assigns a display slot", () => {
  const assigned = assignWorkspaceOutputs(createInitialSpatialGraph(), [output("DP-1")]);
  const expanded = spawnDisplayForWorkspaceOutput(assigned, output("HDMI-1"));
  const added = Object.values(expanded.nodes).find((node) =>
    node.kind === "display" && node.workspaceOutputId === "HDMI-1"
  );
  assert(added?.kind === "display", "unassigned output receives a display");
  assert(added.ordinal === 2, "new output is appended after the existing display");
});

Deno.test("adding a display automatically consumes the first unused physical output", () => {
  const outputs = [output("DP-1"), output("HDMI-1")];
  const assigned = assignWorkspaceOutputs(createInitialSpatialGraph(), outputs.slice(0, 1));
  const expanded = spawnHingedDisplayWithAutomaticOutput(assigned, "display-1", outputs);
  const added = expanded.nodes["display-2"];
  assert(added?.kind === "display", "new spatial display should exist");
  assert(added.workspaceOutputId === "HDMI-1", "unused physical output should be selected");
});

Deno.test("adding a display remains unassigned when every physical output is in use", () => {
  const outputs = [output("DP-1")];
  const assigned = assignWorkspaceOutputs(createInitialSpatialGraph(), outputs);
  const expanded = spawnHingedDisplayWithAutomaticOutput(assigned, "display-1", outputs);
  const added = expanded.nodes["display-2"];
  assert(added?.kind === "display", "new spatial display should still be created");
  assert(added.workspaceOutputId == null, "no physical output should be stolen");
});

Deno.test("displays expose named four-sided attachment slots", () => {
  const graph = createInitialSpatialGraph();
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const slot = graph.hitboxes[`display-1-${side}-slot`];
    assert(slot?.side === side, `${side} slot should exist`);
    assert(slot.accepts.includes("display"), `${side} slot should accept displays`);
  }
  assert(
    graph.nodes.keyboard?.constraint?.kind === "hinge" &&
      graph.nodes.keyboard.constraint.attachmentSlotId === "display-1-bottom-slot",
    "default keyboard should occupy the bottom slot",
  );
});

Deno.test("hinged displays use requested slots and cannot double-occupy them", () => {
  let graph = createInitialSpatialGraph();
  graph = spawnHingedDisplay(graph, "display-1", "left");
  const left = graph.nodes["display-2"];
  assert(
    left?.constraint?.kind === "hinge" &&
      left.constraint.attachmentSlotId === "display-1-left-slot",
    "display should attach to requested left slot",
  );
  assert(left.constraint.axis === "y", "left/right hinges rotate around Y");
  const unchanged = spawnHingedDisplay(graph, "display-1", "left");
  assert(unchanged === graph, "occupied slot should reject another display");

  graph = spawnHingedDisplay(graph, "display-1", "top");
  const top = graph.nodes["display-3"];
  assert(
    top?.constraint?.kind === "hinge" &&
      top.constraint.attachmentSlotId === "display-1-top-slot",
    "display should attach to requested top slot",
  );
  assert(top.constraint.axis === "x", "top/bottom hinges rotate around X");
});

Deno.test("a detached display can snap into another display attachment slot", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = detachFromParent(graph, "display-2");
  graph = commitSpatialNodeTransformAndSnap(graph, "display-2", {
    position: [-0.52, 0, 0.025],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  const display = graph.nodes["display-2"];
  assert(display?.parentId === "display-1", "display should reparent to slot owner");
  assert(
    display.constraint?.kind === "hinge" &&
      display.constraint.attachmentSlotId === "display-1-left-slot",
    "display should become a left-slot hinge",
  );
});

Deno.test("ripping a hinge preserves hierarchy until the free node is placed", () => {
  const attached = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const ripped = releaseHinge(attached, "display-2");
  const display = ripped.nodes["display-2"];
  assert(display?.parentId === "display-1", "breakaway should retain its logical parent");
  assert(display.constraint == null, "breakaway should release only the hinge constraint");
});

Deno.test("explicit detach frees a slot for a different spatial node", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = detachFromParent(graph, "display-2");
  const previous = graph.nodes["display-2"];
  assert(previous?.parentId === null && previous.constraint == null, "display becomes free");

  graph = attachSpatialNodeToSlot(graph, "display-2", "display-1-left-slot");
  const attached = graph.nodes["display-2"];
  assert(attached?.parentId === "display-1", "explicit attach reparents the node");
  assert(
    attached.constraint?.kind === "hinge" &&
      attached.constraint.attachmentSlotId === "display-1-left-slot",
    "explicit attach records slot occupancy",
  );
});

Deno.test("reset pose preserves free placement but clears rotation and scale", () => {
  let graph = createInitialSpatialGraph();
  graph = detachFromParent(graph, "keyboard");
  graph = commitNodeTransform(graph, "keyboard", {
    position: [1, 2, 3],
    rotation: [0.2, -0.3, 0.4],
    scale: [1.5, 1.5, 1.5],
  });
  graph = resetSpatialNodeTransform(graph, "keyboard");
  const keyboard = graph.nodes.keyboard;
  assert(keyboard?.kind === "keyboard", "keyboard fixture should survive reset");
  assert(
    keyboard.localTransform.position.join(",") === "1,2,3",
    "free reset should not teleport the spatial element",
  );
  assert(keyboard.localTransform.rotation.join(",") === "0,0,0", "rotation resets");
  assert(keyboard.localTransform.scale.join(",") === "1,1,1", "scale resets");
});

Deno.test("reset pose returns an attached element to its slot hinge angle", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const display = graph.nodes["display-2"];
  assert(display?.constraint?.kind === "hinge", "display should start attached");
  graph.nodes[display.id] = {
    ...display,
    constraint: { ...display.constraint, angle: 0.6 },
  };
  graph = resetSpatialNodeTransform(graph, display.id);
  const reset = graph.nodes[display.id];
  assert(reset?.constraint?.kind === "hinge" && reset.constraint.angle === 0, "hinge resets");
});

Deno.test("reset pose leans a hinged keyboard back out to its slot's angle, not flat", () => {
  let graph = createInitialSpatialGraph();
  const keyboard = graph.nodes.keyboard;
  assert(keyboard?.constraint?.kind === "hinge", "keyboard should start hinged");
  const resting = keyboard.constraint.angle;
  assert(resting < -0.5, "the keyboard's slot leans it out");
  graph.nodes.keyboard = { ...keyboard, constraint: { ...keyboard.constraint, angle: 0.1 } };
  graph = resetSpatialNodeTransform(graph, "keyboard");
  const reset = graph.nodes.keyboard;
  assert(
    reset?.constraint?.kind === "hinge" && reset.constraint.angle === resting,
    "the keyboard's hinge goes back to the slot's resting angle",
  );
});

Deno.test("a hinged display meets its parent's panel edge on every side", () => {
  for (const side of ["left", "right", "top", "bottom"] as const) {
    // The default keyboard occupies the bottom slot; free it so every side can be exercised.
    const base = detachFromParent(createInitialSpatialGraph(), "keyboard");
    const graph = spawnHingedDisplay(base, "display-1", side);
    const gap = hingeEdgeGap(graph, side);
    assert(gap < 0.0001, `a ${side} hinge should leave no gap between panels (${gap} m)`);
  }
});

Deno.test("normalizing a saved layout re-seats a scaled hinge on the panel edge", () => {
  const graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const parent = graph.nodes["display-1"];
  const child = graph.nodes["display-2"];
  assert(parent?.kind === "display" && child != null, "hinge fixture should exist");
  // Scales changed after the hinge was created: the persisted childPivot no longer matches the
  // child's rendered size, which is exactly the state an old saved layout loads in.
  graph.nodes[parent.id] = {
    ...parent,
    localTransform: { ...parent.localTransform, scale: [1.7, 1.7, 1.7] },
  };
  graph.nodes[child.id] = {
    ...child,
    localTransform: { ...child.localTransform, scale: [0.9, 0.9, 0.9] },
  };
  assert(hingeEdgeGap(graph, "right") > 0.05, "a stale pivot should separate the scaled panels");

  const normalized = normalizeSpatialLayout(graph);
  const gap = hingeEdgeGap(normalized, "right");
  assert(gap < 0.0001, `normalization should re-seat the hinge (${gap} m gap left)`);
});

Deno.test("normalizing a layout saved under the old panel size closes the hinge gap", () => {
  const graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const child = graph.nodes["display-2"];
  assert(child?.constraint?.kind === "hinge", "hinge fixture should exist");
  // A layout written before the panel metrics were corrected: the whole attachment table, slot
  // pivots included, is stale, not just the node's own pivot.
  const staleDisplayPivots: Record<string, [number, number, number]> = {
    left: [-0.52, 0, 0],
    right: [0.52, 0, 0],
    top: [0, 0.285, 0.025],
    bottom: [0, -0.285, 0.025],
  };
  for (const slot of Object.values(graph.hitboxes)) {
    slot.attachments.display = {
      ...slot.attachments.display!,
      parentPivot: staleDisplayPivots[slot.side],
    };
  }
  graph.nodes[child.id] = {
    ...child,
    constraint: { ...child.constraint, parentPivot: [0.52, 0, 0], childPivot: [-0.52, 0, 0] },
  };
  assert(hingeEdgeGap(graph, "right") > 0.1, "the old table should leave a visible gap");

  const normalized = normalizeSpatialLayout(graph);
  const gap = hingeEdgeGap(normalized, "right");
  assert(gap < 0.0001, `the rebuilt table should close the gap (${gap} m left)`);
});

Deno.test("resizing a hinged panel keeps its hinged edge on the pivot", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = commitHingePose(graph, "display-2", 0.4, 1.5);
  const resized = graph.nodes["display-2"];
  assert(resized?.constraint?.kind === "hinge", "the node should still be hinged");
  assert(resized.localTransform.scale[0] === 1.5, "the uniform scale should be committed");
  assert(resized.constraint.angle === 0.4, "the angle should survive the resize");
  assert(
    Math.abs(resized.constraint.childPivot[0] + PANEL_HALF_WIDTH * 1.5) < 0.00001,
    "the child pivot must follow the panel's new half-extent",
  );
  const gap = hingeEdgeGap(graph, "right");
  assert(gap < 0.0001, `a resized hinge must stay flush (${gap} m gap)`);
});

Deno.test("normalization keeps the keyboard tray hang and is a no-op when already correct", () => {
  const graph = createInitialSpatialGraph();
  const keyboard = graph.nodes.keyboard;
  assert(keyboard?.constraint?.kind === "hinge", "keyboard should start hinged");
  assert(
    keyboard.constraint.parentPivot[1] < -PANEL_HALF_HEIGHT,
    "the keyboard tray pivot should hang below the panel edge",
  );
  assert(
    normalizeSpatialLayout(graph) === graph,
    "an already-normalized layout should be returned unchanged",
  );
});

Deno.test("recenter puts the primary display in front of the head and keeps the arrangement", () => {
  let graph = createInitialSpatialGraph();
  graph = spawnDisplayForWorkspaceOutput(graph, output("2"));
  const spawned = Object.values(graph.nodes).find((node) =>
    node.kind === "display" && node.id !== "display-1"
  );
  assert(spawned != null, "expected a spawned display");
  graph = detachDisplayHierarchy(graph, spawned.id);
  const loose = graph.nodes[spawned.id];
  assert(loose?.parentId == null, "expected a second root display");
  graph = commitNodeTransform(graph, "display-1", {
    position: [3, 1, 2],
    rotation: [0, 0.4, 0],
    scale: [1, 1, 1],
  });
  graph = commitNodeTransform(graph, loose.id, {
    position: [3, 1.5, 2],
    rotation: [0, 0.4, 0],
    scale: [1, 1, 1],
  });
  const gapBefore = worldPointOf(graph, "display-1", [0, 0, 0])
    .distanceTo(worldPointOf(graph, loose.id, [0, 0, 0]));

  // Head at (0, 1.6, 0) turned 90 degrees left: forward is -x.
  const recentered = recenterSpatialRoots(graph, [0, 1.6, 0], Math.PI / 2, [0, -0.08, -1.35]);
  const primary = worldPointOf(recentered, "display-1", [0, 0, 0]);
  assert(
    primary.distanceTo(new THREE.Vector3(-1.35, 1.52, 0)) < 1e-6,
    `primary at ${primary.toArray()}`,
  );
  // The panel faces the head: its forward (-z) points along the head's forward (-x).
  const facing = worldPointOf(recentered, "display-1", [0, 0, -1]).sub(primary);
  assert(facing.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-6, `facing ${facing.toArray()}`);
  const gapAfter = primary.distanceTo(worldPointOf(recentered, loose.id, [0, 0, 0]));
  assert(Math.abs(gapAfter - gapBefore) < 1e-6, "roots keep their spacing");
  assert(
    worldPointOf(recentered, loose.id, [0, 0, 0]).y - primary.y > 0.499,
    "recenter does not tilt the arrangement",
  );
});

Deno.test("recenter stands a tipped-over primary display back up", () => {
  // Tipped about 112 degrees back and rolled: the panel faces up and away from the head.
  const tipped = commitNodeTransform(createInitialSpatialGraph(), "display-1", {
    position: [-2.3, 1.3, 1.6],
    rotation: [1.96, 0.04, 1.27],
    scale: [1, 1, 1],
  });
  const recentered = recenterSpatialRoots(tipped, [0, 1.6, 0], 0, [0, -0.08, -1.35]);
  const primary = worldPointOf(recentered, "display-1", [0, 0, 0]);
  const facing = worldPointOf(recentered, "display-1", [0, 0, -1]).sub(primary);
  const panelUp = worldPointOf(recentered, "display-1", [0, 1, 0]).sub(primary);
  assert(Math.abs(facing.x) < 1e-6, `facing ${facing.toArray()}`);
  assert(facing.z < -Math.cos(Math.PI / 6) + 1e-6, `faces the head: ${facing.toArray()}`);
  assert(panelUp.y > Math.cos(Math.PI / 6) - 1e-6, `stands upright: ${panelUp.toArray()}`);

  // A small deliberate tilt survives.
  const leaned = commitNodeTransform(createInitialSpatialGraph(), "display-1", {
    position: [0, 1.5, -1],
    rotation: [-0.2, 0, 0],
    scale: [1, 1, 1],
  });
  const kept = recenterSpatialRoots(leaned, [0, 1.6, 0], 0, [0, -0.08, -1.35]);
  const keptRotation = kept.nodes["display-1"]?.localTransform.rotation;
  assert(
    keptRotation != null && Math.abs(keptRotation[0] + 0.2) < 1e-6 &&
      Math.abs(keptRotation[1]) < 1e-6 && Math.abs(keptRotation[2]) < 1e-6,
    `tilt kept: ${keptRotation}`,
  );
});

Deno.test("recenter brings a lost keyboard back under the primary display", () => {
  let graph = detachFromParent(createInitialSpatialGraph(), "keyboard");
  graph = commitNodeTransform(graph, "keyboard", {
    position: [40, -3, 12],
    rotation: [0, 2, 0],
    scale: [0.38, 0.38, 0.38],
  });
  const recentered = recenterSpatialRoots(graph, [0, 1.6, 0], 0, [0, -0.08, -1.35]);
  const keyboard = recentered.nodes.keyboard;
  assert(keyboard?.parentId === "display-1", "keyboard reparented to the primary display");
  assert(
    keyboard.constraint?.attachmentSlotId === "display-1-bottom-slot",
    "keyboard hinged to the bottom slot",
  );

  // A display already hanging below the primary keeps the slot; the keyboard just moves along.
  let occupied = detachFromParent(spawnHingedDisplay(graph, "display-1", "bottom"), "keyboard");
  occupied = recenterSpatialRoots(occupied, [0, 1.6, 0], 0, [0, -0.08, -1.35]);
  assert(occupied.nodes.keyboard?.constraint == null, "taken bottom slot leaves the keyboard free");

  const deleted = deleteSpatialNode(createInitialSpatialGraph(), "keyboard");
  assert(deleted.nodes.keyboard == null, "keyboard deleted");
  const restored = recenterSpatialRoots(deleted, [0, 1.6, 0], 0, [0, -0.08, -1.35]).nodes.keyboard;
  assert(
    restored?.constraint?.attachmentSlotId === "display-1-bottom-slot",
    "a deleted keyboard is recreated under the primary display",
  );
});

Deno.test("locking a node is a no-op when unchanged and survives a clone", () => {
  const graph = createInitialSpatialGraph();
  assert(setSpatialNodeLocked(graph, "display-1", false) === graph, "unlocking an unlocked node");
  const locked = setSpatialNodeLocked(graph, "display-1", true);
  assert(locked.nodes["display-1"].locked === true, "locked flag set");
  assert(graph.nodes["display-1"].locked !== true, "original graph untouched");
  const moved = commitNodeTransform(locked, "display-1", {
    position: [1, 1, 1],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  assert(moved.nodes["display-1"].locked === true, "lock kept across later edits");
});

Deno.test("mouse block sets the flag, and unblocking clears it", () => {
  const graph = createInitialSpatialGraph();
  assert(setSpatialNodeMouseBlocked(graph, "display-1", false) === graph, "already unblocked");
  const blocked = setSpatialNodeMouseBlocked(graph, "display-1", true);
  assert(blocked.nodes["display-1"].mouseBlocked === true, "flag set");
  assert(graph.nodes["display-1"].mouseBlocked === undefined, "original graph untouched");
  const cleared = setSpatialNodeMouseBlocked(blocked, "display-1", false);
  assert(!("mouseBlocked" in cleared.nodes["display-1"]), "unblocking removes the field");
});

Deno.test("auto-hide is a flag that clears when off", () => {
  const graph = createInitialSpatialGraph();
  assert(setSpatialNodeAutoHide(graph, "display-1", false) === graph, "already off");
  const on = setSpatialNodeAutoHide(graph, "display-1", true);
  assert(on.nodes["display-1"].autoHide === true, "flag set");
  assert(graph.nodes["display-1"].autoHide === undefined, "original graph untouched");
  const off = setSpatialNodeAutoHide(on, "display-1", false);
  assert(!("autoHide" in off.nodes["display-1"]), "turning it off removes the field");
});

Deno.test("opacity is clamped, and full opacity clears the field", () => {
  const graph = createInitialSpatialGraph();
  assert(setSpatialNodeOpacity(graph, "display-1", 1) === graph, "opaque is already the default");
  const faded = setSpatialNodeOpacity(graph, "display-1", 0.5);
  assert(faded.nodes["display-1"].opacity === 0.5, "opacity set");
  assert(graph.nodes["display-1"].opacity === undefined, "original graph untouched");
  assert(setSpatialNodeOpacity(faded, "display-1", 0).nodes["display-1"].opacity === 0.1, "floor");
  assert(setSpatialNodeOpacity(faded, "display-1", NaN) === faded, "NaN ignored");
  const restored = setSpatialNodeOpacity(faded, "display-1", 1);
  assert(!("opacity" in restored.nodes["display-1"]), "opaque leaves no field behind");
});

Deno.test("anchoring a child re-anchors its whole hierarchy; recenter and snapping skip it", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  const pose = {
    position: [0.1, -0.05, -0.4],
    rotation: [0, 0, 0],
    scale: [0.5, 0.5, 0.5],
  } as const;
  graph = setSpatialRootOrigin(graph, "display-2", "left-hand", {
    position: [...pose.position],
    rotation: [...pose.rotation],
    scale: [...pose.scale],
  });
  assert(graph.nodes["display-1"].originId === "left-hand", "root re-anchored");
  assert(graph.nodes["display-2"].originId === "left-hand", "child follows its root");
  assert(graph.nodes["display-1"].localTransform.position[2] === -0.4, "root pose replaced");
  assert(graph.nodes["display-2"].parentId === "display-1", "hierarchy kept");

  // Recenter only moves world-anchored windows: nothing is left to move here.
  assert(
    recenterSpatialRoots(graph, [0, 1.6, 0], 0, [0, -0.08, -1.35]) === graph,
    "hand-attached layout is not recentered",
  );

  // A world display placed on the hand display's left slot does not latch onto it. A spawned
  // display hinges onto the group and inherits the hand origin; detached it keeps it, so it is
  // moved back to the world explicitly.
  graph = spawnDisplayForWorkspaceOutput(graph, output("2"));
  const spawned = Object.values(graph.nodes).find((node) =>
    node.kind === "display" && node.id !== "display-1" && node.id !== "display-2"
  );
  assert(spawned?.originId === "left-hand", "spawned into the hand group");
  graph = detachDisplayHierarchy(graph, spawned.id);
  assert(graph.nodes[spawned.id].originId === "left-hand", "detaching keeps the origin");
  const slotPosition = worldPointOf(graph, "display-1", [-DISPLAY_PANEL_WIDTH, 0, 0.0125]);
  const slotPose = {
    position: slotPosition.toArray() as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [0.5, 0.5, 0.5] as [number, number, number],
  };
  graph = setSpatialRootOrigin(graph, spawned.id, "scene-origin", slotPose);
  const world = graph.nodes[spawned.id];
  graph = commitSpatialNodeTransformAndSnap(graph, world.id, slotPose);
  assert(graph.nodes[world.id].parentId == null, "no snapping across origins");
});

Deno.test("curvature is clamped, and flat clears the field", () => {
  const graph = createInitialSpatialGraph();
  assert(setSpatialNodeCurvature(graph, "display-1", 0) === graph, "flat is already the default");
  const curved = setSpatialNodeCurvature(graph, "display-1", 0.2);
  assert(curved.nodes["display-1"].curvature === 0.2, "curvature set");
  assert(graph.nodes["display-1"].curvature === undefined, "original graph untouched");
  assert(
    setSpatialNodeCurvature(curved, "display-1", 3).nodes["display-1"].curvature === 0.5,
    "cap",
  );
  assert(setSpatialNodeCurvature(curved, "display-1", NaN) === curved, "NaN ignored");
  assert(
    !("curvature" in setSpatialNodeCurvature(curved, "display-1", -1).nodes["display-1"]),
    "flat",
  );
});

Deno.test("a display's toolbar goes beside it when the stack fills above and below", () => {
  let graph = createInitialSpatialGraph();
  assert(graph.nodes.keyboard?.parentId === "display-1", "the default keyboard hangs below");
  assert(displayToolbarSide(graph, "display-1") === "above", "a keyboard below pushes it above");

  graph = spawnHingedDisplay(graph, "display-1", "top");
  assert(displayToolbarSide(graph, "display-1") === "left", "window above, keyboard below");
  assert(displayToolbarSide(graph, "display-2") === "above", "the top window's parent is below it");

  graph = spawnHingedDisplay(graph, "display-1", "left");
  assert(
    displayToolbarSide(graph, "display-1") === "right",
    "a window on the left takes the right",
  );

  // A parent counts too: this window's parent is below it and its child above.
  let tower = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "top");
  tower = spawnHingedDisplay(tower, "display-2", "top");
  assert(tower.nodes["display-3"]?.parentId === "display-2", "a third window stacks on top");
  assert(displayToolbarSide(tower, "display-2") === "left", "a parent below counts as taken");
});
