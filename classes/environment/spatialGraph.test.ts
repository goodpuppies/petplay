import {
  createInitialSpatialGraph,
  deleteSpatialNode,
  ensureDefaultSpatialContent,
  getDisplayAttachmentRole,
  getSpatialNodeWorldMatrix,
  spawnHingedDisplay,
} from "./spatialGraph.ts";

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

Deno.test("display roles ignore cascade-owned controls", () => {
  const initial = createInitialSpatialGraph();
  assert(
    getDisplayAttachmentRole(initial, "display-1") === "parent",
    "default keyboard makes the root a parent",
  );
  const withoutKeyboard = deleteSpatialNode(initial, "keyboard");
  assert(
    getDisplayAttachmentRole(withoutKeyboard, "display-1") === "solo",
    "cascade-owned controls alone should not make the root a parent",
  );

  const chain = spawnHingedDisplay(initial, "display-1");
  assert(getDisplayAttachmentRole(chain, "display-1") === "parent", "root should be parent");
  assert(getDisplayAttachmentRole(chain, "display-2") === "child", "leaf should be child");
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

Deno.test("deleting the last content can be recovered when the layer is reopened", () => {
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
