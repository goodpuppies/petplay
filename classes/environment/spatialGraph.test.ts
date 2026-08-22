import {
  assignWorkspaceOutput,
  assignWorkspaceOutputs,
  attachSpatialNodeToSlot,
  commitNodeTransform,
  commitSpatialNodeTransformAndSnap,
  createInitialSpatialGraph,
  deleteSpatialNode,
  detachDisplayHierarchy,
  detachFromParent,
  ensureDefaultSpatialContent,
  getDisplayAttachmentRole,
  getSpatialNodeWorldMatrix,
  initializeWorkspaceLayoutOutputs,
  reconcileWorkspaceOutputs,
  releaseHinge,
  resetSpatialNodeTransform,
  spawnDisplayForWorkspaceOutput,
  spawnHingedDisplay,
  spawnHingedDisplayWithAutomaticOutput,
} from "./spatialGraph.ts";
import type { WorkspaceOutput } from "./workspaceDisplays.ts";

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
