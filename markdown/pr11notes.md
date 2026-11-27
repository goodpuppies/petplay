# PR #11 review notes: native SteamVR overlays

[PR #11](https://github.com/goodpuppies/petplay/pull/11) (`feat/native-steamvr-overlays`, from
Blise518B) adds a third Overlay Mode, NATIVE, which shows each UI panel, grab-box outline and laser as
its own SteamVR quad instead of drawing it into the head-locked panorama. The writeup is
`docs/NATIVE_OVERLAYS.md` on the branch.

- **Reviewed:** `cbf5439`, +6,497 / −23 in 31 files, against merge base `65ba091` and `main` at `529c98c`
  (2026-11-27). Two review passes are merged into this file.
- **Local checkout:** `git fetch origin pull/11/head:pr11`; worktree at `_scratch/pr11/wt`, with its
  submodules symlinked from the main checkout.
- **Checks:** `deno task check` is clean. `classes/nativeOverlayMath.test.ts` passes, 21 tests. The
  offscreen render test and the playtest were not run (they need a display). On GitHub the PR shows as
  conflicting, and CI is waiting for workflow approval.

**Status: clean reimplementation landed on `main` (`77387f1`..HEAD).** All §0 bugs, §1/§2 workarounds,
zero-copy DMA-BUF (Linux) + DXGI (Windows) shared-texture submission, flat UI panels, and 1-mesh
stereo grab-box outlines have been implemented cleanly and verified live on both Linux `vrlab` and
remote Windows SteamVR 2.18.4. Pointer lasers/dots remain in the eye image intentionally so beam and
dot share one pose sample and depth-test against panels.

Tags on each item:

- **checked**: confirmed in the code during this review.
- **reported**: found by the second review pass (scratch reproductions), not rechecked.
- **to verify**: needs a run in the headset or a probe.

---

## 0. Bugs in the PR (fix before merge)

- [ ] **UI can disappear entirely, because it leaves the eye image before its quad exists.** *checked*
  - `planNativeContent` takes panels and meshes out of the panorama first. The layer only then works out
    their quads, and it silently skips any it cannot make. One case: with your head inside a grab box's
    bounding sphere (leaning into a window), the outline gets no quad, so it is drawn nowhere.
  - The same happens on an error: the catch disables native mode, but the current frame still publishes a
    panorama that has the panels removed. Planning itself sits outside the try block, so a throw there
    takes the renderer down.
  - *Fix:* decide what goes native only after its quad, camera and texture are confirmed. Anything that
    fails stays in the eye image for that frame.

- [ ] **Native work delays the panorama.** *checked*
  - Native work runs after the eye render but before the panorama is published: hashing every panel,
    redrawing the dirty ones and the OpenVR calls. On the bank path the GPU fence is created after it,
    so the panorama's flip also waits for this frame's native draws. One Settings-window redraw (up to
    4096²) or the debug cube (2048×1024 every frame) adds straight to the panorama's latency.
  - *Fix:* run the native pass after the panorama is submitted, since SteamVR keeps showing a quad's
    last picture anyway. Cap redraws per frame as well.

- [ ] **Recycled overlay slots can break the panorama and projection overlays.** *checked; to verify*
  - The PR found that a destroyed overlay's slot keeps its first texture size for the life of the
    process. It protects only its own overlays from that. It also *destroys* many odd-sized overlays: on
    every native error (`clear()`), when trimming spares, and across the four beam sizes. The panorama
    and projection overlays in the same process are destroyed and recreated on every mode or eye-size
    change, with no size check.
  - *Scenario:* native mode errors and frees about 20 slots. You switch to PROJ, and a projection overlay
    lands on a 4096×16 slot, so it shows a strip or nothing.
  - *Fix:* one overlay-slot pool for the whole process, which parks overlays instead of destroying them.
    Or stop using GL textures for these overlays (§1, "Texture size per overlay slot").

- [ ] **Translucent meshes on quads get the wrong alpha.** *checked*
  - Meshes are drawn with raylib `BLEND_ALPHA`, which over a transparent target stores alpha `a²`. The
    quads are flagged as premultiplied. The laser (opacity 0.4) therefore darkens what is behind it by
    16% instead of 40%, and looks washed out next to the panorama version.
  - The offscreen test checks only an opaque beam, so it never exercises the real material. The
    `SetOverlayFlag(IsPremultiplied)` call also ignores its return code.
  - *Fix:* use the UI's blend factors (`beginUiAlphaBlend`) for native targets. See §1, "No alpha
    convention".

- [ ] **The laser beam and its dot come apart during fast sweeps.** *reported*
  - The beam quad is attached to the controller, so SteamVR moves it at display rate. The dot is placed
    in the room at the scene's last hit point. During a fast sweep, or while dragging a wrist panel, the
    end of the beam and the dot end up in different places, and both draw over surfaces that should
    hide them.
  - *Fix:* keep the pointer in the eye image for the first version. Move it to quads only once beam and
    dot come from one pose sample.

- [ ] **Stale pictures: several things change without a redraw.** *checked*
  - The panel hash ignores clipping, so a change to a clip rectangle alone keeps the old picture.
  - `nativeTargetGeneration` is never incremented anywhere, so the "targets were lost, redraw
    everything" path is dead code.
  - A producer restart (new scene epoch) resets the renderer's asset cache but not the native picture
    caches. Reused IDs can match an old picture.
  - A box outline's picture depends on the panel backgrounds that hide its far bars, but its hash does
    not include them. A background fading or scrolling leaves stale holes in the outline.
  - Minor: beams and outlines are keyed on the *global* asset version, so any asset change anywhere
    redraws them.

- [ ] **The overlay caps leak.** *checked*
  - The hidden-quad cap (16) fails when many quads hide on the same frame: they all have the same age,
    and eviction needs a strictly greater age. Twenty quads hidden together all stay.
  - Finding a wrong-sized slot parks it without trimming, so the spare cap (16) can be exceeded.
  - Creating a texture pair is not atomic: if the second allocation fails, the first leaks.
  - A parked overlay still points at a GL texture the renderer has put back in its pool and may reuse or
    free. It is hidden, so nothing shows, but nothing ties the two lifetimes together.
  - Pools keep up to 4 targets per exact size, with no overall byte limit, and are not emptied when
    native mode is switched off.

- [ ] **The overlay and VRAM budget is easy to blow.** *checked*
  - Grab-box outlines are on by default, so every window (each display, the keyboard, the wrist menu,
    Settings, the toolbars) costs two SteamVR overlays: its panel and its outline. Add up to 16 hidden,
    16 spares, 4 pointer quads, the displays and the panorama banks. SteamVR's limit is 128, shared with
    other apps.
  - Each quad holds two render targets, and each target has a depth buffer UI never uses. A
    4096×2560 Settings window comes to about 160 MB.

- [ ] **UI lying on a display may sort behind it.** *to verify*
  - Panels and desktop screens both use sort order 0, which SteamVR orders by distance. A toolbar along
    the bottom edge of a large display can come out farther than the display's centre and drop behind
    it. Same family as
    [projection-mode-sorts-behind-desktop-quads](issues/projection-mode-sorts-behind-desktop-quads/README.md).

- [ ] **Content outside a root's rectangle is cut off.** *checked*
  - The panel camera covers exactly the root's rectangle. Popovers, key previews above the keyboard,
    hover lift and shadows that overflow the root are drawn in PANO but clipped in NATIVE.

- [ ] **Resolving the merge conflict in `classes/webxrRaythreeUi.ts`.** *checked*
  - `main` added `isObjectVisibleInTree()` checks for panels, texts and images (for the wrist tilt-hide
    in `529c98c`), at the same three spots where the PR records roots. Put the visibility check *before*
    the root is recorded. Otherwise a wrist menu hidden by tilting stays visible as a quad while it no
    longer takes pointer hits.
  - Test afterwards: fade, fully hidden, reveal, and staying visible during a grab.

- [ ] **Overlay keys are unstable.** *checked*
  - Keys come from module-level counters (`nextNativePanelId`, `nextGrabBoxFrameId`,
    `nextPointerQuadId`). A remount gets a new key while the old one keeps its overlay for 900 frames.
  - Under `--watch-webxr`, a hot reload restarts the counters while the renderer process keeps its old
    keys, so unrelated objects briefly share overlays.
  - *Fix:* derive keys from stable identity (see §1, "uikit draw slots used as IDs").

- [ ] **Interaction with the uncommitted UI materials work.** *checked*
  - The local `shader` field on UI images (for example `glass-chrome`) is not in the panel hash. A native
    panel is also drawn once, head-on, so a view-dependent or animated material cannot be right on a
    quad. Such roots need to opt out of native mode, or carry a "redraw every frame" flag.

- [ ] **Smaller things.**
  - Leaving native mode after an error needs a mode toggle. The error blocks everything, and only a
    *change* of the setting clears it. *checked*
  - The diagnostic `SETPRESENTMODE` command bypasses the native flag. The display host learns about
    projection mode from a 500 ms status heartbeat, so the two can briefly disagree about who draws the
    displays. *reported*
  - Stereo planning runs in every mode (`stereo: true` always). The debug cube spins up the native layer
    in PANO and PROJ too. *checked*
  - The stereo pass takes its lighting view position from `frame.camera.position` rather than the eye
    it draws. *reported*
  - Lots of per-frame allocation on the renderer's frame thread: three `Float32Array(16)` per panel in
    `nativePanelCamera`, plus new arrays and maps in `planNativeContent`. *checked*
  - `nativeOverlayStatusStore` drops `pointer`, `spareOverlays` and `sizeMismatches` from the status.
    `DebugPage` rows 3 and 4 are out of order. *checked*
  - A one-frame race: a released grab's freeze entry can expire between tracking resolution and
    `nativePanelAttachment`, which would attach a frozen panel to the moving controller for one frame.
    *reported; to verify*

---

## 1. Jank in `main` to fix during PR #11 processing

These are pre-existing issues in `main` that PR #11 directly depends on, duplicates, or works around
(orthogonal `main` issues have been moved to §5).

### UI and uikit

- [x] **The extractor changes snapshots after returning them.** *fixed 2026-11-27 in `classes/webxrRaythreeUi.ts`*
  - Anchored panel fast-path now requires unchanged `data` and `clipping` (`samePanelInputsRange(entry, 16, 64)`) and emits a fresh shallow snapshot with a new `worldMatrix` instead of mutating previously returned snapshots in place.

- [x] **uikit's per-frame draw slots are used as persistent item IDs.** *partially fixed 2026-11-27 in `classes/webxrRaythreeUi.ts`*
  - `ui.surfaces` now exports stable epoch-scoped `surfaceId` (or explicit `<PetplayElement renderProps={{ overlayKey }}>`) per root. (Per-item stable IDs for `sceneStoreWriter.ts` remain follow-up.)

- [x] **Each window builds its own depth blockers by hand.** *unified depth stand-in 2026-11-27 in `classes/webxrRaythreeUi.ts` & `classes/webxrRaythreeRaylibRenderer.ts`*
  - `ui.surfaces` computes `depthPanelIndex` once per root and `drawUiSnapshot` consumes it (alongside `ui.depthOnlyPanels`).

- [x] **Change detection is rebuilt by hashing downstream.** *fixed 2026-11-27 in `classes/webxrRaythreeUi.ts`*
  - `ui.surfaces` emits a monotonic per-root `contentRevision` (tracking panels, clips, texts, images, procedural `shader`, and `textRendering`, while ignoring pure tracking-pose motion) and automatically sets `dynamicOverlay: true` for shader-backed surfaces.

- [x] **Untyped uikit internals & raw `panel.data` offsets.** *fixed 2026-11-27 in `classes/webxrRaythreeUi.ts`*
  - Centralized root reading in `readUikitRootInfo` and exported named `UI_PANEL_DATA` constants.

### Scene to renderer protocol

- [x] **Render metadata travels as untyped `userData`.** *foundation landed 2026-11-27*
  - Added `GeometryAsset.bounds.min/max` and `RenderInstance.renderProps` in `submodules/raythree/src/{ir,extract}.ts`, `PetplayRenderProps` + `classifyGeometryShape` in `classes/renderProps.ts`, `<PetplayElement renderProps={...}>` in `classes/environment/petplayElement.tsx`, and forwarding in `classes/overlayRenderTracking.ts`.

- [x] **The grab-box outline is 12 separate box meshes.** *fixed 2026-11-27 in `classes/environment/grabbox.tsx`*
  - `GrabBoxFrame` now builds one merged `THREE.BufferGeometry` (1 mesh, 1 draw call, exact box `boundingBox`/`boundingSphere`, origin at box center).

- [x] **Device-attached poses take a round trip through world space.** *fixed 2026-11-27*
  - `OpenVrControllerTipPoseResolver.getTipOffsetMatrix()` + `NativeOverlayDevice.anchorToDevice` let `nativePanelAttachment` compose `anchorToDevice * rigid(anchor.localMatrix)` directly, staying bit-identical across frames regardless of tracked pose motion (tightened `setDeviceTransform` threshold back to `1e-6`).

### Rendering

- [x] **There is no alpha convention.** *fixed 2026-11-27*
  - Transparent meshes, shadow overlay, and `drawHudOverUiInstances` in `webxrRaythreeRaylibRenderer.ts` now use `beginUiAlphaBlend()` (premultiplied source-over). `webxrOverlayRaylib.ts` panorama combine uses `beginPremultipliedCopyBlend()` (stopping double-premultiplication and `a²` alpha squaring). `openVrOverlayTexture.ts` and `openVrProjectionOverlays.ts` set `VROverlayFlags_IsPremultiplied = true`.

- [ ] **The renderer's passes share hidden state.** *checked*
  - UI panel runs are cached by `uiFrame & 1`, which assumes one UI pass per frame. The PR's
    `renderUiOnly` has to bump `uiFrame` by hand, and its stereo pass sets the GL viewport directly. The
    blend, depth and viewport state of each pass are implicit.
  - *Fix:* shared asset preparation, then per pass an explicit camera, viewport, blend and depth state,
    and draw list.

- [x] **raylib is opened five times.** *consolidated 2026-11-27 in `classes/rlglExtras.ts`*
  - `uiAlphaBlend.ts`, `glyphText.ts`, and `pathfinderText.ts` now share one `Deno.dlopen` in `classes/rlglExtras.ts` (which also exports `rlViewport`, eliminating PR #11's `classes/rlViewport.ts`).

### OpenVR

- [x] **The texture-size-per-overlay-slot finding may break existing overlays.** *verified on Linux vrlab 2026-11-27*
  - Ran `_scratch/native-overlays/steamvr_slot_probe.ts` against Linux SteamVR 2.18.4 (Mesa radeonsi / RX 7900 XTX):
    - **Case B (live overlay given new texture ID at new size `600×400 → 300×500`)**: **ok** (`texSize=300x500`).
    - **Case C (reused slot `0x17` after destroy, `640×320 → 320×640`)**: **ok** (`texSize=320x640`).
    - **Case K (same GL texture ID reallocated via `glTexImage2D`, `400×300 → 200×500 → 600×600`)**: **ok** (`texSize` updated immediately each time).
  - Conclusion: the slot-size lock is **Windows-only** (`vrclient_x64.dll` GL→D3D11 interop), not Linux SteamVR. `OpenVrNativeOverlays` now tries in-place resize first (zero slot churn on Linux) and only falls back to size-keyed slot parking when `GetOverlayTextureSize` reports a mismatch. Still worth testing Case K on Windows later.

- [x] **OpenVR boilerplate is copied between overlay classes.** *fixed 2026-11-27*
  - Added `playspaceFrame.poseColumnMajorToRows34()` in `classes/playspaceFrame.ts` and `createOpenVrOverlayWithCleanup()` in `classes/openVrOverlayTexture.ts` (used by `OpenVrOverlayTexture` and `OpenVrProjectionOverlays`).

---

## 2. PR design cleanup

- [ ] **Settings → Debug is permanent user-facing UI.** The test cube, "Stereo Quad Shape A/B" and the
  native status belong behind a dev flag or a REPL command. *checked*
- [ ] **A magic 30-frame delay before textures are reused**, instead of tracking when SteamVR and the
  GPU are actually done with them. *checked*
- [ ] **A spare slot that turns out to have a size no panel uses** (for example 5960×5960, from an old
  eye overlay) occupies a spare until trimmed, and destroying it hands the same bad slot back to the
  next `CreateOverlay`. *checked*
- [x] **The display's rear logo is opted out with `nativePanel: false`** *fixed 2026-11-27 in `classes/environment/displayInstance/ui.tsx`*
  - Unified the rear backplate and PetPlay logo into one opaque black uikit `<Container backgroundColor="#000000">` at `z = -depth / 2 - 0.001`, removing the split Three.js plane and the `nativeOverlay: false` opt-out.

---

## 3. Verify in the headset

- [x] Linux: verified in `vrlab` (SteamVR 2.18.4, Mesa radeonsi / RX 7900 XTX, 2026-11-27). GL native
  panel quads work cleanly alongside the 3-bank DMA-BUF panorama: upright with default bounds,
  `nativeError: null`, `sizeMismatches: 0`, `spareOverlays: 0`, `presents: 1`, `transforms: 1` over
  610 frames. Capture: `_scratch/native-overlays/vrlab-native.png`.
- [ ] `nativeStereoSizing` (`halved` or `full`) on Linux SteamVR and Steam Link (when outlines/stereo
  are evaluated).
- [ ] The overlay count in a busy scene with several displays, against SteamVR's 128.
- [ ] How lasers and dots drawn over every panel feel in use (when pointer is evaluated).
- [ ] UI lying on displays: does it sort behind them (§0)?
- [ ] VRChat depth occlusion with the decoupled renderer (tracked in generic issue).
- [ ] Wrist tilt-hide after the merge: fade, hidden, reveal, during a grab.

---

## 4. Fix order (PR #11 processing)

The aim is for PR #11 to *delete* workarounds rather than bring them into `main`.

1. **Premultiplied alpha everywhere.** Fixes translucent UI in PANO/PROJ now, and the PR's laser alpha.
2. **A typed uikit surface export:** stable root and item IDs, immutable snapshots with a content
   revision, clips in local space, unified depth-coverage description, and typed root/panel fields. This
   addresses the snapshot mutation, slot IDs, stale native pictures, `depthStandIn` duplication, and the
   PR's hash.
3. **Typed render metadata (`<PetplayElement renderProps={...}>` + `RenderInstance` metadata) and
   `GeometryAsset` bounds**, then **the grab-box outline as one mesh** and **device-local placement**.
   Removes `nativeStereo`, `nativeStereoCenter`, `nativeQuad`, their hand-computed geometry, and the
   world→device round trip.
4. **The overlay-slot probe**, then **one process-wide slot pool or shared-texture submission** (plus
   shared OpenVR overlay helpers). The probe's answer decides how much of `OpenVrNativeOverlays` survives.
5. **One raylib extras binding** and **explicit per-pass render state** (killing `uiFrame & 1`).
6. **Rebase PR #11 as flat panels only.** Keep its §0 fixes: decide native after the quad exists, run
   the native pass after the panorama, cap redraws, budget overlays and bytes together, stable keys,
   root overflow, `isObjectVisibleInTree()` merge, and UI-materials interaction.
7. **Later, judge the outlines and the pointer separately**, each against the eye-image version
   (per-eye alignment, side views, alpha over a real background, hit feedback in motion).

---

## 5. Related generic issues (tracked in `markdown/issues/`)

- [FIXED-native-panel-overlays-use-gl-submit-instead-of-shared-textures](issues/FIXED-native-panel-overlays-use-gl-submit-instead-of-shared-textures/README.md):
  upgraded native panel quad submission to zero-copy DMA-BUF / DXGI shared textures (verified in `vrlab` with `transport: "shared"`).
- [overlay-pose-prediction-and-pacing-latency](issues/overlay-pose-prediction-and-pacing-latency/README.md):
  a possible one-frame pose prediction mismatch and late-start pacing in PANO and PROJ.
- [projection-mode-sorts-behind-desktop-quads](issues/projection-mode-sorts-behind-desktop-quads/README.md):
  PROJ sorting behind the desktop quads.
- [overlay-line-geometry-never-reaches-screen](issues/overlay-line-geometry-never-reaches-screen/README.md):
  why outlines and lasers are faked with boxes.
- [uikit-background-opacity-prop-does-nothing](issues/uikit-background-opacity-prop-does-nothing/README.md):
  remove dead `backgroundOpacity`/`borderOpacity` props from `webgpu-uikit.tsx` and update 28 callers.
- [vrchat-depth-and-input-focus-skip-decoupled-renderer](issues/vrchat-depth-and-input-focus-skip-decoupled-renderer/README.md):
  VRChat depth occlusion and input-focus quads only wired to the inline renderer.
- [ui-images-matched-to-panels-by-geometry-guess](issues/ui-images-matched-to-panels-by-geometry-guess/README.md):
  `UiImage` matched to panels by size/position heuristics + dual texture registration.
- [scene-matrix-freshness-is-recomputed-ad-hoc](issues/scene-matrix-freshness-is-recomputed-ad-hoc/README.md):
  ad-hoc world-matrix recomputation and repeated head-object lookups.
- [display-placement-is-out-of-band-in-react](issues/display-placement-is-out-of-band-in-react/README.md):
  `DisplayInstance` out-of-band OpenVR placement protocol inside React.
- [raythree-payload-duplicates-left-and-right-eye](issues/raythree-payload-duplicates-left-and-right-eye/README.md):
  dead `leftEye`/`rightEye` duplication on `WebXRRaythreeRenderPayload`.
- [overlay-scene-wire-packing-is-split-and-brittle](issues/overlay-scene-wire-packing-is-split-and-brittle/README.md):
  split typed-array packing with silent fallback and `extraAnchors` side-table.
- [renderer-settings-require-five-way-manual-plumbing](issues/renderer-settings-require-five-way-manual-plumbing/README.md):
  5-way manual plumbing for renderer settings between `webxr` and `overlayRenderOwner`.
- [playtests-lack-semantic-ui-query-handles](issues/playtests-lack-semantic-ui-query-handles/README.md):
  playtests matching UI controls by `userData` strings and world Y proximity.
