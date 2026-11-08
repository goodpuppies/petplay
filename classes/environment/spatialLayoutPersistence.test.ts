import {
  getLayoutSlotPath,
  listLayoutSlots,
  loadSpatialLayoutSync,
  parseSpatialLayout,
  saveSpatialLayoutSync,
  serializeSpatialLayout,
  spatialLayoutPersistenceEnabled,
} from "./spatialLayoutPersistence.ts";
import {
  attachSpatialNodeToSlot,
  createInitialSpatialGraph,
  detachFromParent,
  spawnHingedDisplay,
} from "./spatialGraph.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("spatial layout round-trips hierarchy, transforms, and assignments", () => {
  let graph = spawnHingedDisplay(createInitialSpatialGraph(), "display-1", "right");
  graph = detachFromParent(graph, "display-2");
  graph.nodes["display-2"] = {
    ...graph.nodes["display-2"],
    localTransform: {
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
      scale: [1.2, 1.2, 1.2],
    },
  };
  const display = graph.nodes["display-1"];
  assert(display?.kind === "display", "display fixture should exist");
  graph.nodes[display.id] = {
    ...display,
    toolbarSidePreference: "right",
    workspaceOutputId: "DP-1",
    workspaceOutputName: "Main",
    workspaceCrop: { x: 0, y: 0, width: 0.5, height: 1 },
  };

  const restored = parseSpatialLayout(serializeSpatialLayout(graph));
  assert(restored != null, "serialized graph should parse");
  assert(JSON.stringify(restored) === JSON.stringify(graph), "graph should round-trip exactly");
});

Deno.test("spatial layout rejects corrupt, cyclic, and unknown-version data", () => {
  assert(parseSpatialLayout("not json") == null, "corrupt JSON should be ignored");
  const graph = createInitialSpatialGraph();
  graph.nodes["display-1"].parentId = "keyboard";
  graph.nodes.keyboard.parentId = "display-1";
  assert(parseSpatialLayout(serializeSpatialLayout(graph)) == null, "cycles should be ignored");
  const unknown = JSON.parse(serializeSpatialLayout(createInitialSpatialGraph()));
  unknown.version = 999;
  assert(parseSpatialLayout(JSON.stringify(unknown)) == null, "unknown versions should be ignored");
});

Deno.test("spatial layout saves atomically to an explicit path", () => {
  const directory = Deno.makeTempDirSync({ prefix: "petplay-layout-test-" });
  const path = `${directory}/nested/layout.json`;
  try {
    const graph = attachSpatialNodeToSlot(
      detachFromParent(createInitialSpatialGraph(), "keyboard"),
      "keyboard",
      "display-1-bottom-slot",
    );
    saveSpatialLayoutSync(graph, path);
    const restored = loadSpatialLayoutSync(path);
    assert(JSON.stringify(restored) === JSON.stringify(graph), "saved graph should load");
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("desktop persistence has exactly one scene owner", () => {
  assert(spatialLayoutPersistenceEnabled(["dev"]), "normal VR scene persists");
  assert(!spatialLayoutPersistenceEnabled(["dev", "--desktop"]), "hidden desktop host does not");
  assert(
    spatialLayoutPersistenceEnabled(["--desktop-control-child", "--desktop"]),
    "desktop viewer persists",
  );
});

Deno.test("layout slots live beside the live layout and list only loadable files", () => {
  const dir = Deno.makeTempDirSync();
  const live = `${dir}/spatial-layout.json`;
  try {
    assert(getLayoutSlotPath(2, live) === `${dir}/layouts/slot-2.json`, "slot path");
    let threw = false;
    try {
      getLayoutSlotPath(0, live);
    } catch {
      threw = true;
    }
    assert(threw, "slot 0 is rejected");
    saveSpatialLayoutSync(createInitialSpatialGraph(), getLayoutSlotPath(2, live));
    Deno.writeTextFileSync(getLayoutSlotPath(3, live), "not json");
    const slots = listLayoutSlots(live);
    assert(slots[0] === null && slots[2] === null, `slots ${JSON.stringify(slots)}`);
    const expectedDisplays = Object.values(createInitialSpatialGraph().nodes)
      .filter((node) => node.kind === "display").length;
    assert(slots[1]?.displays === expectedDisplays, `slot 2 ${JSON.stringify(slots[1])}`);
    assert(Math.abs((slots[1]?.savedAt ?? 0) - Date.now()) < 60_000, "slot 2 saved just now");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
