import {
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
