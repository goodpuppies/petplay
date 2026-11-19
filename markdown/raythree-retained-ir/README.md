# Retained raythree IR

> **Superseded (19 November 2026)** by [scene-stream](../scene-stream/README.md), which keeps
> this plan's decisions and adds a glTF-aligned schema, the IR as a reactive store, and network
> streaming to a browser. The prior-art, review and baseline notes here still apply.

> **Status (16 October 2026): deferred.** Smaller changes covered the measured need first, as
> suggested in [review.md](./review.md):
> - The worker skips publishing unchanged scenes (`classes/overlaySceneFingerprint.ts`), so
>   idle decode fell from 1.78 to 0.04 ms/frame.
> - Anchored items keep bit-identical local matrices while nothing moves, which is most of P1's
>   invariant for hand-attached UI.
> - Grab-carried windows are sent relative to the controller (`renderTrackingFollow`).
>
> The remaining cost is a scene that changes every frame: the worker spends ~10 ms per frame
> (see [the worker issue](../issues/webxr-worker-saturates-when-the-scene-changes-every-frame/README.md)).
> Revisit this plan, with review.md's points folded in, if those fixes are not enough.

Make the scene stream between the scene producer (the webxr worker running Three.js) and the
decoupled renderer cost about as much as **what changed**, not as much as **what exists**. Both
sides keep a copy of the scene; the producer sends only the changes.

This is the plan. Prior art and what each source contributes are in
[prior-art.md](./prior-art.md). The measurements behind it are in [baseline.md](./baseline.md).

## Why

The wrist jitter investigation
([panorama-controller-jitter.md](../projection-overlay-re/panorama-controller-jitter.md))
found that the decoupled renderer's own frame cost drives the visible shaking. Freezing scene
adoption made motion almost smooth. Profiles showed scene decode at about 1.8 ms per scene, plus
the GC it causes, all inside a frame budget of about 11 ms. Every frame today:

- the producer walks, lowers and sorts the whole scene;
- it serializes the full snapshot, about 114 KB of base64;
- the renderer decodes every item again and allocates fresh objects;
- the renderer rebuilds whatever is keyed on world matrices (text batches), even when the only
  change is a tracked hand that the renderer re-anchors anyway.

In the live PetPlay scene about 85% of items are byte-identical from frame to frame. The ones
that change are mostly hand-anchored items whose world-baked matrices move with the hand.

## Scope: general scenes, not the PetPlay UI

The renderer is meant to draw arbitrary Three.js and WebXR content: games, R3F apps, large
static worlds, many movers, instanced crowds, skinned characters. The PetPlay UI, with about
230 items, is the first workload, not the design target. Rules that follow from that:

- The core IR knows about spatial nodes, items, assets, lights and views. uikit panels, glyph
  text and images are **item kinds** added by plugins, like raythree's lowerers. They are not
  special top-level fields.
- Nothing in the protocol may assume a small N. Every per-frame cost must scale with the number
  of changes (or, as a temporary step, with a cheap per-item compare), never with serialize and
  decode of the whole scene.
- Tracked anchors are WebXR concepts (viewer, grip spaces, target-ray spaces), not PetPlay
  concepts. A generic WebXR game gets late-latched controllers without tagging anything.

## Decisions

1. **The renderer owns a retained scene database.** The current `ExtractionResult` stays as
   the snapshot format for bootstrap, resync, tests and stateless consumers. It stops being the
   per-frame runtime message.
2. **Spatial nodes are separate from items.** An item refers to a spatial node and carries a
   matrix local to that node. Moving a node is one update, whatever the size of its subtree.
3. **Tracked spatial nodes get their transform from the renderer.** These are the head and the
   left/right grip and ray. The renderer reads them at its own pose-sample time (late latching).
   The producer never bakes a tracked pose into an item.
4. **No field holds a world-space value derived from a node it doesn't own.** Clip planes,
   bounds and text vertices are expressed in their spatial node's space. Today's
   `resolveRenderAnchors` clipping fix-up is the symptom this rule removes.
5. **Delivery is "latest state since the last acknowledged receipt", not a FIFO of deltas.**
   This generalizes `OverlayAssetCache` / `OverlaySceneCredit` from assets to every table. A
   skipped or lost packet loses nothing: the next one carries every entity whose version is
   newer than the acknowledged one. Many writes before a send collapse into one.
6. **No changes means no packet.** The renderer keeps drawing retained state with fresh anchors.
7. **The logical model is records; the wire is SoA typed-array batches** in one slab per packet
   (building on `overlaySceneBuffers.ts`), with a string table. The logical API can stay
   ergonomic in TypeScript.
8. **Generic code lives in `submodules/raythree`.** That covers the IR tables, retained store,
   transaction codec and equivalence tests. PetPlay supplies item kinds (uikit panels, glyph
   text, images) and the tracked-node source.
9. **Correctness comes first.** The state after `apply(snapshot₀, deltas…)` must equal
   `snapshotₙ`, and that is enforced by tests. Receipts carry a cheap state checksum. A mismatch
   triggers a full resync rather than a silently wrong scene.

## Model

### Tables (renderer side)

| Table | Key | Contents | Typical change rate |
|---|---|---|---|
| spatial nodes | `NodeId` | parent, local transform (f64 affine; TRS later), `tracked?: TrackedSpace` | movers: per frame; most: never |
| items | `ItemId` | header plus kind payload (below) | rare, except state animations |
| geometries / materials / textures | `AssetId` | as today, revisioned | rare |
| lights | `NodeId` | as `LightFrame`, positioned by spatial node | rare |
| views | eye/view | camera, projection | per frame (the renderer can own these too) |

**Item header (every kind):** `kind`, `spatialNode`, `localMatrix`, `visible`, `layerMask`,
`orderKey` (renderOrder, transparency class, uikit order info as an opaque sortable key),
`bounds` (local), `version`.

**Kind payloads are split into field groups.** Each group has its own dirty bit, so a renderer
can tell "one uniform write" from "pipeline rebuild":

| Kind | Field groups |
|---|---|
| `mesh` | binding (geometry, material), flags (shadows, hudOverUi) |
| `instancedMesh` | binding, instance buffer ref, count |
| `uiPanel` (plugin) | instance data block, clipping (node-local), depth flags |
| `uiText` (plugin) | glyph geometry asset ref, color/opacity, clipping, layout bounds |
| `uiImage` (plugin) | texture key, size, panel link |
| later: `skinnedMesh` | binding, bone palette buffer ref |

Large per-instance arrays (instance matrices, bone palettes, panel instance blocks) become
**retained buffer assets** patched by range, like Three's `BufferAttribute.updateRanges`.

### Spatial nodes: which Object3Ds become nodes

Not every Object3D. A node is created for:

- **tracked roots:** viewer, grip and ray spaces (`XRSpace` objects in pmndrs, `renderTrackingAnchor` tags in PetPlay);
- **independently moving subtrees**, detected as objects whose `matrixWorld` changes while their
  parent's doesn't, plus explicit hints such as "grabbed window root";
- the **world root**.

Everything in between is flattened into the item's `localMatrix` relative to its nearest node.
A static chain under a moving node costs nothing per frame. A node that starts or stops moving
is promoted or demoted by the producer. That is a structural change, which is rare and
allowed to cost more.

Arbitrary non-decomposable matrices stay affine. TRS with f64 translation and f32
rotation/scale is a later wire option for large N. It is not needed for correctness.

### Producer side: finding changes

- **Tier 1 (first):** keep a "last sent" table per entity and compare cheaply: matrix floats,
  field-group hashes, Three's `version` counters for assets. This is still O(N) per frame, but
  numeric compares only. No lowering into fresh objects, no serialize, no decode.
- **Tier 2 (later):** use dirty hints so unchanged entities aren't visited at all. Sources:
  - uikit is built on `@preact/signals-core`, so effects can mark panels and texts dirty, as in
    reactivesurfacecompositor v0.2;
  - R3F's prop application;
  - `matrixWorldNeedsUpdate` / `matrixAutoUpdate` hooks;
  - BufferAttribute versions and update ranges.

  Tier 1 stays as the fallback and as a debug-mode validator. In debug mode, run both and
  assert tier 2 missed nothing.
- **Output must depend on values, not just on execution.** An effect that runs and produces
  the same value emits nothing. (RSC's `keyed()` re-inserting every row is the anti-pattern to
  avoid.)
- **Sorting moves to the renderer.** The producer sends order keys. The renderer re-sorts only
  when membership or keys change.

### Transaction

```ts
interface SceneTransaction {
  stream: string;          // epoch; a new stream means the renderer resets to the bundled snapshot
  sequence: number;
  baseAck: number;         // producer's highest acknowledged version when this was built
  nodes:   { upsert: NodeBatch;  remove: Uint32Array };
  items:   { upsert: ItemBatch;  remove: Uint32Array };   // upserts carry a per-item group mask
  assets:  AssetBatch;                                   // as today; plus buffer range patches
  buffers?: BufferPatch[];                               // instance/bone/panel data ranges
  lights?: LightBatch;
  strings?: string[];                                    // new interned strings since baseAck
}
```

- An entity appears when its version is greater than the acknowledged version. Its upsert
  carries only the field groups changed since then, or everything when the entity is new to the
  renderer.
- Removals are tombstones kept until a receipt covers them.
- The receipt is `{ sequence, appliedVersion, checksum }`.

### Renderer side: applying and drawing

- Apply upserts and removes in place. Keep derived state incrementally:
  - **World matrices:** computed per draw only for items under nodes that moved, including
    tracked nodes every frame. That's one 4×4 multiply per affected item, no allocation.
    Normal matrices are derived here and dropped from the wire.
  - **Draw lists and sort:** rebuilt only on membership or order-key change.
  - **Batches** (uikit panel instance buffer, text vertex batches): built in node-local space
    and drawn with the node matrix as model matrix/uniform. They are patched by range when
    their items change and are **never rebuilt for motion**. This removes the current text
    rebuilds driven by a moving hand.
- Frustum culling uses the retained bounds. It never changes residency and never generates IR
  traffic.
- `resolveRenderAnchors` disappears; tracked nodes are simply inputs to the world-matrix pass.

## Phases

Each phase has a measurable exit. Keep the synthetic-driver sweep running for visual checks
(see the jitter doc) and record numbers in [baseline.md](./baseline.md).

### P0: Permanent instrumentation

- Producer health: bytes per section (nodes, items by kind, assets), entities changed per
  frame by table, extract/compare/encode ms.
- Renderer health: decode/apply ms, derived-state work (matrix recomputes, batch patches and
  rebuilds, sorts), GC time.
- Turn `utils/petplay-ir-probe-*.js` (REPL eval bodies) into a one-command probe tool.
- Exit: the baseline is reproducible with one command.

### P1: Express anchored items relative to their node

This works within the current snapshot wire and is the fastest measurable win.

- Anchored items send `localMatrix` and node-local clipping. Drop the world-baked
  `worldMatrix` and world clipping for them.
- The renderer composes world matrices from tracked anchors. Text and panel batches for
  anchored roots keep node-local vertices and use the anchor as model matrix.
- Exit: under the 1 Hz/±20 cm sweep, panels and texts changing per frame go from about 16/12
  to about 0, text batch rebuilds per frame go to about 0 during hand motion, and renderer
  p95 drops measurably.

### P2: Retained tables and delta transactions

- In raythree: the IR table types, a `RetainedSceneStore` (renderer), a `SceneDeltaWriter`
  (producer, tier-1 compare), and the transaction codec. `ExtractionResult` becomes
  `snapshot()` and `restore(snapshot)`.
- PetPlay: register UI item kinds; move webxr's `publishRaythreeFrameToViews` and
  overlayRenderOwner's inbox onto it. Generalize the credit/ack code instead of duplicating it.
- Equivalence tests: random scene mutation sequences, random dropped and late packets. The
  invariant is that the renderer store equals a fresh snapshot.
- Exit: steady-state packet size and decode/apply time are proportional to changes, empty
  frames send nothing, and the checksum shows no mismatch over a long soak.

### P3: Wire encoding

- Use SoA batches in one slab and a string table. Transfer the ArrayBuffer instead of a base64
  string if the child transport allows it; otherwise use binary framing on the existing pipe.
- Exit: encode plus decode is under 0.2 ms for a typical delta, and no per-item JS objects are
  allocated on decode for transform-only updates.

### P4: General spatial hierarchy

- Promote and demote moving subtrees. Add explicit hints (grabbed window → child of the
  grabbing hand's ray node while grabbed, which also fixes grabbed-window lag).
- Exit: moving a 1,000-item subtree costs one node update. Covered by a synthetic scene test.

### P5: Fine-grained assets and dirty hints

- BufferAttribute and texture range patches, instanced-matrix range updates, skinned bone
  palettes.
- Tier-2 dirty hints from uikit signals and R3F, with tier 1 as the validator.
- Exit: synthetic benchmarks (below) meet budget; a static scene visits 0 entities per frame.

### P6 (optional): Priorities and budgets

- If there are several producers (world, UI, avatars, remote content), give each a surface
  with priority and a per-frame apply budget in the renderer, as in RSC's compositor.
  Tracked-pose-dependent work is never deferred.

## Benchmarks (synthetic scenes in raythree)

These keep the design honest beyond the PetPlay UI:

| Scene | What it stresses |
|---|---|
| 10k static meshes, 0 movers | idle cost should be about 0 bytes and about 0 ms |
| 10k static + 500 independent movers | per-mover cost, wire size per transform |
| 1 mover with a 1k-item subtree | spatial hierarchy (P4) |
| 100k-instance InstancedMesh, 1% updated per frame | buffer range patches |
| 300 uikit panels + 300 texts, 20 changing text strings | UI kinds, glyph asset reuse |
| everything hand-anchored, hand sweeping | late latching, no rebuild on motion |
| frequent add/remove churn (particles, spawning) | structural path, tombstones |

Metrics per scene: producer extract/compare/encode ms, bytes per frame, renderer decode/apply
ms, derived-state work, GC, and the equivalence check.

**Budgets** (initial, revisit after P0): producer ≤ 0.5 ms and renderer apply ≤ 0.5 ms per
frame for typical deltas. Bytes per frame scale with changes and are 0 when static.

## Risks and open questions

- **Drift between producer shadow and renderer store.** Mitigated by equivalence tests,
  receipt checksums and full resync on mismatch or stream change.
- **Promote/demote churn** for objects that move intermittently. Needs hysteresis.
- **Precision:** keep f64 affine until benchmarks show bytes matter. Then consider TRS with
  f64 translation.
- **Who owns cameras.** In PetPlay the renderer already computes its own eye views. For a
  generic WebXR app, should the producer's camera be advisory only?
- **Order semantics across uikit roots** are currently renderer-side heuristics
  (`rootIndex`). Order keys must keep that behavior.
- **Multiple consumers** (projection renderer, desktop views): one writer per consumer, as
  `OverlaySceneWireEncoder` is today, or a shared version log with per-consumer ack.
- **The skip flag `bridge: { kind: "skip" }`** and the separate UI snapshot path should
  converge on item kinds, so the wrist menu isn't a special case.

## Code today (starting points)

- `submodules/raythree/src/ir.ts`, `extract.ts`, `lowerers.ts`: snapshot IR and extractor;
  revisioned assets.
- `classes/webxrRaythreeScene.ts`: builds the payload (one extract per frame).
- `classes/webxrRaythreeUi.ts`: uikit panel, text and image snapshot (`captureRenderAnchor`).
- `classes/overlaySceneDelivery.ts`: asset cache, credits, inbox.
- `classes/overlaySceneWire.ts`: compact wire with UI glyph geometry refs.
- `classes/overlaySceneBuffers.ts`: single-slab typed-view packing.
- `classes/overlayRenderTracking.ts`: render anchors and `resolveRenderAnchors`.
- `classes/webxrRaythreeRaylibRenderer.ts`: renderer; text batch invalidation by world matrices.
- `petplay/webxr.ts` `publishRaythreeFrameToViews`, `petplay/overlayRenderOwner.ts`.
