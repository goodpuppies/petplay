# Baseline

## 2026-11-19: synthetic lab, full UI, current payload

Setup: `deno task vrlab up --no-vrchat` (synthetic headset and Touch hands, scratch layout and
settings), the wrist menu turned to face the head, and the window layer shown (displays and
keyboard). There is no VRChat and no registered view: the overlay renders in-worker. Measured
with `deno run -A --no-check utils/scene-stream-probe/run.ts`, which wraps
`state.raythreeSceneBridge.buildPayload` for 60 calls per phase (observing, never calling it),
restores it, and walks the live three scene read-only.

### What the IR has to represent

The drawn scene is small. The three scene has 908 meshes, but most never draw:

| Three objects (visible through ancestors) | Count | In today's IR as |
| --- | ---: | --- |
| uikit `Container`/`Content` pick meshes, `material.visible = false` | 638 | nothing (pointer targets only) |
| uikit text meshes (`NodeMaterial`, glyph attributes) | 101 | `ui.texts` |
| uikit `InstancedPanelMesh` (`aData*`, `aClipping*`) | 3 | 97 `ui.panels` |
| depth-only occluders (`colorWrite: false`) | 9 | raythree instances |
| other `MeshBasicNodeMaterial` meshes | 4 | raythree instances |
| meshes under `bridge: skip` (the wrist menu) | 56 | `ui.*` only |

- Materials in the scene: `MeshBasicMaterial` (753, almost all pick meshes),
  `MeshBasicNodeMaterial` (16), uikit's `NodeMaterial` (139). No `ShaderMaterial`. Every drawn
  mesh is unlit, so the first schema needs **unlit only**, plus `uiQuad` and `textRun`.
- Textures in materials: two `DataTexture` font atlases (512×512 and 409×1343). Images
  (wallpaper, icons) arrive as string keys into the renderer's registry, without pixels.
- Fonts used by texts: `roboto` and `material-icons`.
- Lights: ambient, directional, point; nothing drawn is lit.

### Payload per frame

One payload: 12 instances, 97 panels, 101 texts, 5 images, 3 lights. V8-serialized sizes:

| Section | Bytes |
| --- | ---: |
| instances | 5,317 |
| ui panels | 35,132 (~362 per panel) |
| ui texts | 61,917, of which glyph geometry 19,680 |
| ui images | 1,815 |
| lights + camera + shadow frame | 1,543 |
| **whole payload** (left eye; the right eye is aliased) | **106,256** |

`buildPayload`: 0.76–0.79 ms p50, ≤1.04 ms p95.

### Changes per frame

| Phase | Instances | Panels | Texts | Images |
| --- | ---: | ---: | ---: | ---: |
| idle | 0 | 0 | 0 | 0 |
| right hand sweeping (wrist menu attached), 1 Hz ±20 cm | 0.8 | 13.3 | 10.0 | 0.8 |
| left hand sweeping (pointer ray only) | 0 | 0 | 0 | 0 |

Every change in the right-hand sweep is one of the hand-anchored items (16 panels, 12 texts,
1 instance, 1 image carry a `renderAnchor`): their world matrices are baked from the hand.
Nothing else changes. The means are below the anchored counts because some frames saw no new
pose.

### What this means for the plan

- Under the new model (decisions 2 and 4: node-local items, tracked spaces filled in by the
  renderer), **both measured motion cases produce zero store changes**. Idle and hand motion are
  0 bytes on the state track; only interaction (hover, presses, typing, layout edits) writes.
- The snapshot is the cost that remains: ~106 KB now. Texts are the largest part, and shaped
  glyph runs against an atlas asset should shrink them well below today's 62 KB (to be measured
  in P3).
- The browser renderer's first scope is small: unlit meshes, depth-only occluders, `uiQuad`,
  `textRun`, images. Images need pixels in the store (decision 8); today they have none.
- Pick-only meshes must not enter the store. They are inputs to server-side picking, not
  render content.

Not covered yet: interaction-heavy phases (typing, scrolling, dragging a window), the VRChat
camera and depth views, and real desktop displays (holes in this scene; their pixels live in
OpenVR overlays). The October measurement with VRChat and a real headset is in
[raythree-retained-ir/baseline.md](../raythree-retained-ir/baseline.md) (114 KB, the same 16
anchored panels changing).

## 2026-11-19: the scene store, meshes only (P2)

Same lab and phases, measured with `run.ts --probe=store.js`: each live frame is extracted again
by a fresh extractor, written into a `SceneStore` through `classes/sceneStoreWriter.ts`, encoded,
decoded and applied to a replica. UI kinds are not in the store yet (P3), so this covers
instances, lights and their assets.

| | Idle | Right hand sweeping | Left hand sweeping |
| --- | ---: | ---: | ---: |
| commits per frame | 0 | 0 | 0 |
| delta bytes | 0 | 0 | 0 |
| writer ms (p50 / p95) | 0.079 / 0.201 | 0.075 / 0.094 | 0.075 / 0.100 |
| encode ms (p50) | 0.015 | 0.014 | 0.018 |
| replica apply ms (p50) | 0.011 | 0.010 | 0.011 |

- The hand-anchored mesh is stored under the right-grip node with a constant local matrix, so
  the sweep that changed it in 0.8 of every frame of today's payload commits nothing.
- The replica's state hash matched the producer's after every frame.
- Snapshot: 17,152 bytes (12 geometries 8.4 KB, 12 materials 2.9 KB, 12 items 4.0 KB, 6 nodes
  1.5 KB, 3 lights 1.2 KB).
- The writer's cost is the per-frame compare (polled writer). The fresh extraction it runs on
  (0.3 ms p50) is probe overhead; in production it reuses the bridge's extraction.
