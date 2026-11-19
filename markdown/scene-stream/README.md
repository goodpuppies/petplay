# Scene stream: a reactive, replicated, glTF-aligned IR

Stream PetPlay's scene to other renderers as a scene, not as video: the local raylib overlay, a
desktop view, a browser tab (three.js, optionally real WebXR), another PetPlay instance. The
renderer owns the camera and the tracked poses, so head motion is local wherever the scene is
drawn.

This replaces [raythree-retained-ir](../raythree-retained-ir/README.md), which designed the
local half (spatial nodes, nothing baked into world space, latest-since-ack, field-group dirty
bits). Those decisions stand and its prior-art, review and baseline notes still apply. This plan
adds generality (no three or raylib specifics in the IR), the network, and a reactive store as
the core data structure.

## Why

- **Browser client.** A website that shows PetPlay's UI, with or without OpenVR, using the same
  r3f scene running on the server. Options considered: running the scene in the browser (the
  scene graph has ~40 Deno-only modules, and a second scene means a second spatial graph, the
  `desktopControl` divergence in `docs/ARCHITECTURE.md` §9) and streaming rendered pixels
  (works, but text quality is bitrate-bound and head motion pays the network round trip).
  Streaming the IR keeps one scene and one graph and renders natively on the client.
- **The current IR doesn't stretch to it.** `ExtractionResult` is a per-frame render list with
  the producer's camera; the payload carries two of them (`leftEye`, `rightEye`). uikit travels
  in a parallel snapshot with its own ordering heuristics (`rootIndex`, `bridge: skip`), and
  the raylib renderer reimplements uikit's panel shader. Materials are flattened three
  materials. Text ships as glyph vertex geometry. Textures are string keys into a registry
  local to the renderer, with no pixels. App sidecars (`vrcCamera`, `vrcDepthDebug`, …) ride in
  the scene payload. The wire is V8 structured clone as base64, ~114 KB per changing frame.

## Decisions

1. **glTF-aligned, implemented to need.** The schema has a defined place for what glTF has
   (node hierarchy, meshes with primitives, PBR metallic-roughness and unlit materials,
   textures and samplers, instancing, skins, morph targets, lights, extensions). Only what
   PetPlay draws is implemented at first; the rest exists as reserved shape, so adding it later
   doesn't change the model. MPEG-I Scene Description (ISO/IEC 23090-14) took the same base
   for networked immersive media.
2. **The IR is a reactive store, not a serialization.** It is a set of tables with stable
   ids. Producers write into it; it records what changed. Serialization, deltas, resync and
   replication are all views of that store. See [Store](#store).
3. **One writer per stream.** A stream has one authoritative producer. More producers means
   more streams (or, later, ownership per subtree), never merging. No CRDTs.
4. **Scene and views are separate.** The stream carries scene tables only. Each renderer owns
   its cameras. Tracked spaces (viewer, grips, target rays) are nodes whose transform the
   renderer fills in at draw time (late latching). The producer never bakes a tracked pose
   into anything, and no field holds a world-space value derived from a node it doesn't own.
5. **UI is item kinds in the same tables.** `uiQuad` (SDF rounded rect: size, radii, border,
   fill or image, node-local clip) and `textRun` (string, shaped glyph positions, font-atlas
   asset, colour, clip). Ordering is an explicit order key. `rootIndex`, the separate UI
   snapshot and `bridge: skip` go away.
6. **Extensions with fallbacks.** Item kinds and material models outside the core are named
   extensions, as in glTF. A renderer that doesn't know one uses the declared fallback (or
   skips it and reports it), never guesses.
7. **Video surfaces are an item kind.** `videoSurface` refers to a media track id. A browser
   binds a WebCodecs decoder; locally it maps to the display overlays and remote-feed
   receivers. Display content becomes part of the scene stream instead of a hole.
8. **Assets are content-addressed and carry their data.** Geometry, texture pixels (or an
   encoded image) and font atlases are keyed by content hash. Receivers cache across
   reconnects; late joiners fetch only what they lack.
9. **Correctness first.** `apply(snapshot₀, deltas…)` must equal `snapshotₙ`, enforced by
   randomized tests with dropped and late packets. Receipts carry an incrementally maintained
   state hash (not a full rescan); a mismatch forces a resync.
10. **Two renderers from day one.** The raylib renderer and a browser three.js renderer are
    both consumers while the schema is designed, so it can't drift back to either.

## Store

**Tables.** `nodes` (parent, local transform, `tracked?`), `items` (header: kind, node, local
matrix, visible, layer mask, order key, local bounds; plus a kind payload split into field
groups), `meshes`, `materials`, `textures`, `samplers`, `fonts`, `lights`, `buffers`
(retained typed-array assets patched by range: instance matrices, bone palettes, panel data).
Columns are SoA typed arrays per table, with a string table; the TypeScript API over them stays
record-shaped.

**Change ticks, not signals per field.** One global tick advances per transaction. Every row
stores a `changedTick` per field group (and tables keep tombstones with their tick until every
consumer has acknowledged past it). "Everything changed since tick N" is the delta for any
consumer, whether it is the in-process renderer, a lagging viewer or a late joiner. This is
Bevy's `Changed<T>` model. A signal object per field would cost too much at 10k entities.

**A change journal indexes the ticks.** Finding "changed since N" must not scan the tables.
Each transaction appends `(tick, table, row, fieldGroupMask)` entries to a journal; values are
never copied into it, so it is an index into the current store, not a log of intermediate
values. A row is journaled at most once per tick: if its `changedTick` already equals the
current tick, the write ORs into that entry's mask. A consumer acked at N gets the journal range
(N, now] merged per row, with values read from the store, so building a delta is
O(changes since N). The journal is truncated below the oldest consumer's ack; a consumer whose
range would exceed the store's size (a late joiner, or one far behind) gets a snapshot instead,
which bounds what a slow viewer can cost. Applying a transaction on a replica yields the same
touched-row list, which drives the renderer's incremental derived state directly.

**Writes compare before they mark.** A write with an equal value changes nothing, so a rerun
effect or a polled source that produced the same value emits nothing.

**Two kinds of writers, one store:**

- **Bound writers** for sources that are already reactive. uikit is built on
  `@preact/signals-core`: an effect per panel or text writes its `uiQuad`/`textRun` fields
  when its signals change. No scanning.
- **Polled writers** for imperative three state, mainly `matrixWorld`-derived local
  transforms, compared per frame against the last written value. These are the fallback, and
  in debug mode they also validate the bound writers.

**Transactions are atomic.** Writes inside a frame are batched; consumers see a whole
transaction or none of it. Within a transaction, an asset is always written before anything
that references it.

**Replicas are the same store.** A consumer applies a transaction into its own copy, which
advances the same ticks locally. Renderer-side derived state (world matrices, normal matrices,
draw lists and sort, text and panel batches) is computed incrementally from those ticks: it is
rebuilt only when an input's tick moved. A node moving costs its subtree's matrix updates, not a
batch rebuild.

**Tracked poses bypass the store.** Head and controller poses are high-rate inputs the
renderer samples at draw time, on their own lane. Routing them through the store would make
every frame dirty.

## Transport

**Local** (webxr worker → overlay renderer, desktop view): the existing actor messages, with
one transferred `ArrayBuffer` slab per transaction instead of base64. Delivery is latest since
the consumer's last acknowledged tick, so a slow consumer gets one collapsed transaction, never
a queue of stale ones.

**Network**, over the MoQ/iroh/WebTransport path that `petplay_mediatransport` already has:

- **assets track**: immutable objects keyed by content hash, reliable, cacheable by relays.
- **state track**, structured like video. Each group opens with a snapshot (the keyframe) and
  continues with transactions, so a late joiner starts at a group boundary. Broadcast to many
  viewers needs nothing else.
- **one-to-one**: the viewer acks its applied tick, and the producer sends latest since that
  tick (Quake 3's delta-against-acked-snapshot), which tolerates loss and needs no group
  boundaries except for resync.
- **input**, back to the producer: pointer and ray events, picked on the server as
  [remote-scene-controls.md](../remote-scene-controls.md) does, carrying the tick and view the
  client actually drew so picking matches what was seen.
- **video**: `videoSurface` items refer to existing media tracks.

The first browser client can skip MoQ and use a WebSocket (stageforge's `WebSocketWorker`
already makes a socket look like a worker, so a tab can be an actor). The protocol is the same.

## Phases

### P0: measure (done 2026-11-19, see [baseline.md](./baseline.md))

Rerun `utils/petplay-ir-probe-sections.js` and `utils/petplay-ir-probe-changes.js` against a
live session and record in [baseline.md](./baseline.md) (the October numbers are in
[raythree-retained-ir/baseline.md](../raythree-retained-ir/baseline.md)): bytes by section, entity counts by
kind, changes per frame, extract/encode/decode time. Add which three materials, geometry
attributes and texture sources actually occur, since that bounds what the first schema must
cover. Turn the probes into one command.

### P1: node-local items (folded into P2)

The producer already skipped anchor-derived fields when deciding whether to resend
(`classes/overlaySceneFingerprint.ts`), and the only consumer of anchors is the decoupled
projection renderer (`petplay/overlayRenderOwner.ts`). Reworking today's payload would have been
replaced by the store anyway, so node-local items were built directly into it. The renderer-side
half (text batches that stop rebuilding on hand motion) lands when a renderer moves onto the store.

### P2: the store and the schema, in raythree

**Done 2026-11-19**, in `submodules/raythree/src/store/`:

- `schema.ts`: tables, field groups and value types (glTF-aligned; tracked spaces named as WebXR's).
- `store.ts`: `SceneStore` with compare-before-mark writes, per-group change ticks, transactions,
  the change journal, `changesSince` / `snapshot` / `truncateJournal`, replica `apply`, and the
  incremental 64-bit state hash.
- `codec.ts`: one slab per delta; typed arrays 8-byte aligned and decoded as views.
- `extractionWriter.ts`: the polled writer from `ExtractionResult` with pluggable placement.
- `store.test.ts`: a randomized lossy-link equivalence test through the codec (drops, journal
  truncation forcing snapshots), plus targeted cases. Mutation-checked: breaking the journal's
  remove or re-create handling fails the suite.

PetPlay's writer is `classes/sceneStoreWriter.ts` (anchors onto tracked nodes, two-hand carries
as pair nodes, PetPlay flags as extensions). Live results are in [baseline.md](./baseline.md).

Deferred from P2: SoA column storage (rows are objects behind the same API; switch when the
10k-entity benchmarks need it), content hashes as asset keys (asset ids are the producer's for
now; the network assets track keys by hash in P6), and asset garbage collection (the extractor
never reports a dropped asset).

### P3: UI as item kinds

**P3a done 2026-11-19.** `uiQuad` and `textRun` are in raythree's schema; PetPlay's writer
(`classes/sceneStoreWriter.ts`) turns the UI snapshot into them:

- uikit's packed panel block becomes named fields in UI pixels: size, border widths, corner radii
  (unpacked from base 50 and scaled by height), border bend, sRGB colours.
- World clip planes move into node space (p_node = Nᵀ p_world, tested).
- MSDF geometry becomes 8 floats per glyph. Atlases and UI images are textures carrying their
  PNG bytes; atlases are flagged `flipY` (three-msdf-text-utils' upload convention).
- `UiOrder` makes the draw order explicit: roots back to front, then layer (quads, text),
  renderOrder, uikit's order keys, slot. An image fill is resolved at write time to the slot right
  after the panel it fills, replacing the renderer's geometric matching.
- Snapshot objects that are identical to last frame's are skipped (the UI snapshot never mutates
  one it handed out): 0.19 ms per frame for 215 items idle.

It is still a polled writer over the snapshot. Remaining for P3b: bind uikit's signals directly,
move the raylib renderer onto the store, and delete the separate UI snapshot. The items table
is 104 KB, about today's UI payload: the generic codec spends tags and keys per field, which the
SoA wire (deferred) removes.

### P4: browser renderer

**First slice done 2026-11-19**: the live PetPlay UI renders in a browser, legibly and correctly
layered, from the scene store.

- `classes/sceneStreamServer.ts` runs in the webxr worker, fed from
  `publishRaythreeFrameToViews` (primed from the view asset cache, so a late start has every
  asset). One WebSocket per client, at most one delta in flight, "latest since ack" or a
  snapshot; the journal is truncated to the oldest ack. Tracked poses go as separate JSON pose
  messages: the head from the frame, hands from the scene's `renderTrackingAnchor` objects (the
  exact poses the producer placed items from).
- `web/scene-stream/viewer.ts` (build: `deno task scene-stream:build`) keeps a replica store
  and updates a three.js scene from each transaction's touched rows: unlit/PBR meshes, a GLSL
  rounded-rect shader for `uiQuad` (border, cover-fit image, node-space clip), an MSDF shader for
  `textRun`, per-frame UI sort. Head camera by default; F free camera; G or `?view=fit` frames
  the world-placed content. `globalThis.sceneStream` exposes the internals.
- Verified in the vrlab with headless Chromium: keyboard legends (fi layout, icon glyphs),
  wrist menu (image fill, live clock), displays' logo fills. A clock change arrived as a
  1,096-byte delta. 475 frames published moved the store 3 ticks.

Run it: start PetPlay with `PETPLAY_SCENE_STREAM_PORT=3993` (or from the REPL in the webxr
worker: `import(new URL("../classes/sceneStreamServer.ts", moduleUrl).href).then((m) =>
m.startSceneStream({ port: 3993 }))`), build the viewer once, open `http://127.0.0.1:3993/`.
Loopback only; `PETPLAY_SCENE_STREAM_HOST` binds elsewhere. For a browser on the tailnet,
proxy it instead: `tailscale serve --bg --https=8453 http://127.0.0.1:3993` (the viewer switches
to `wss:` on an HTTPS page; remove with `tailscale serve --https=8453 off`).

Not yet: WebXR in the viewer, input back to the server (P5), display pixels (P5), the
4 MB snapshot (the wallpaper PNG is 3.4 MB of it; re-encode or downscale for the network).

### P5: input and video

Pointer and ray input back to the server with the drawn tick and view. `videoSurface` with the
display feeds over the media path. Exit: a desktop display can be seen and clicked from the
browser.

**Pointer input done 2026-11-19** (video remains), following the desktop controls below.
The browser sends ordinary pointer events plus the camera it drew with; `classes/viewRemotePointer.ts`
poses a per-view camera from that and drives the same pmndrs `forwardHtmlEvents` bridge as the
local raylib window, one bridge per connected view, updated every published frame and destroyed
(cancelling drags) when the view disconnects. Sending the drawn camera, rather than a frame id,
makes picking match what was seen without the server keeping camera history. Verified in the
vrlab: hovering a keycap from headless Chromium came back as that key's `uiQuad` and `textRun`
changes (the hover highlight) within one delta. Presses were not tested in the lab: on Linux the
keyboard sink injects real keystrokes through uinput.

### Desktop controls: one implementation

Desktop and VR control are both first-class in pmndrs, and PetPlay has one implementation of
desktop controls for every desktop view of a scene.

- **Interaction is the scene's.** Hover, press, drag and grab are pmndrs pointer events on the
  server's scene. VR controllers are ray pointers; a desktop view is `forwardHtmlEvents` over the
  camera it drew with. Results return through the store (for remote views).
- **Navigation is `classes/desktopNavigation.ts`.** It is pmndrs `OrbitHandles` on the scene's
  void object, with PetPlay's grab-box filters: on empty space, left drag pans, right drag (or
  two pointers) orbits, wheel (or a pinch) zooms; anything over UI is interaction. The raylib
  desktop viewers (`OrbitHandlesView`) and every browser view use it. A browser view's
  navigation runs on the server (`viewRemotePointer.ts`), restricted to that view's pointers
  by their native pointer ids (pmndrs generates its own scene-side ids), on a camera of its own
  that is sent back as `{ view }`; the browser only renders with it. Its F (follow the headset)
  is local, and G (frame the content) is an `{ aim }` request to the shared navigation.
- **Cost:** navigation from a browser waits a round trip. Local prediction of the same
  computation can come later, if the tailnet latency shows.
- **Next:** the raylib desktop preview (`desktopView`) becomes such a view of the webxr
  scene, replacing `desktopControl`'s second scene and `SETDESKTOPVIEWOFFSET`; touch for phones;
  keyboard focus for text fields.

### P6: network transport

Assets and state tracks over MoQ, viewer acks, keyframe-style groups for broadcast. Exit: a
remote browser over the existing gateway, a late joiner, and loss tolerance in a soak.

### Later

Skins, morph targets and other reserved glTF shape when a scene needs them; tier-2 dirty hints
for three (R3F prop application, `BufferAttribute` versions); priorities and apply budgets per
stream; multiple producers with ownership per subtree.

## Open questions

- **Transparency order.** Order keys cover stable UI layering, but arbitrary transparent
  scenes need view-dependent sorting. The schema must say which items need depth sorting
  rather than assume order changes only with the scene.
- **Text shaping location.** Shaped runs from the producer guarantee identical layout
  (uikit's yoga layout depends on measured text), but a renderer with a better font path might
  want to reshape. Default: producer shapes, renderer draws.
- **Custom materials.** PetPlay's custom shaders (varggles, depth occluders, the key sphere)
  need either extensions or to stay renderer-local effects.
- **Precision on the wire.** f64 local transforms until the 10k-movers benchmark says bytes
  matter, then TRS with f64 translation.
- **Where the browser renderer lives**: raythree (generic) versus the media viewer (one page
  for video and scene).

## Prior art for the additions

- [MPEG-I Scene Description, ISO/IEC 23090-14](https://standards.iteh.ai/catalog/standards/iso/32bc7473-a6f3-4bc0-a8d4-5af31fec38d1/iso-iec-23090-14-2025):
  glTF base, scene updates as JSON patches, full documents as sync samples. The sync-sample
  idea is our snapshot-opened groups.
- [Remote Compose](https://android.googlesource.com/platform/frameworks/support/+/androidx-main/compose/remote/Documentation):
  UI as a versioned operation document played back by a separate renderer.
- **Bevy change detection**: per-component change ticks compared against the reader's last
  run, the model for the store's ticks.
- **Quake 3 networking**: deltas against the last acknowledged snapshot over an unreliable
  channel.
- Scene-representation streaming versus video for XR:
  [DHR](https://arxiv.org/pdf/2210.15835),
  [live 3DGS streaming](https://arxiv.org/abs/2604.02851),
  [XRgo reprojection](https://pbg.cs.illinois.edu/papers/gao25XRgo.pdf).

The in-process precedents (Chromium property trees, WebRender, Hydra, Core Animation, Bevy's
retained render world) are in [raythree-retained-ir/prior-art.md](../raythree-retained-ir/prior-art.md).
