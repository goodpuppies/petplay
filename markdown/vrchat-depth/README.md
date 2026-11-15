# VRChat depth for PetPlay overlays

Plan, started 2026-11-07. Goal: PetPlay's overlays composite with real depth against VRChat, so
hands, avatars and walls in front of a window hide it. VRChat offers no API for this, so a shader on
our own avatar reads VRChat's depth and writes it into the image as pixels, and PetPlay reads those
pixels back. The whole loop is meant to be driven agentically in the synthetic lab
(`deno task vrlab`, `submodules/petplay_ovrdriver`). The one step that needs the user is the avatar
upload.

## Prior art (`research/`, gitignored clones)

- **`swadge-vrchat-bridge`** (cnlohr, MAGFest 2023) is the transport, not depth. A world shader
  (`swadge-bridge-demo/Assets/SwadgeIntegration/SwadgeAppDataExporter.shader`) draws in the
  `Overlay` queue with `ZTest Always` into a corner of the screen. It splits each float into bytes
  with `asuint`, four pixels per float, written through `GammaToLinearSpaceExact` so the bytes
  survive the sRGB target. A magic row `0xaaaaaaaa 0xa5a5a5a5 0x5a5a5a5a` marks the block.
  `bridgeapp/bridgeapp.c` finds the VRChat window (`EnumWindows`), copies it with GDI, searches for
  the magic and decodes. The "stick figures" in the Swadge Player's Guide are Udon bone positions
  passed in as shader arrays, not captured depth.
- **`shadertrixx`** documents the depth read: `_CameraDepthTexture` and
  `GetLinearZFromZDepth_WorksWithMirrors`, and camera detection (`_VRChatCameraMode`,
  `_VRChatMirrorMode`, `unity_StereoEyeIndex`).
- **`openvr-screengrab`** reads `GetMirrorTextureD3D11`. On our Linux SteamVR the GL mirror returned
  102 with a null handle (`markdown/projection-overlay-re/output-capture.md`, measured without a
  scene app; retry with VRChat running). The mirror would also include chaperone and PetPlay's own
  overlays.

Related work the user already has:

- **VRCFluid 1.0.0** (`~/Downloads/VRCFluid-1.0.0.zip`, a world package):
  `Shaders/Rendering/GrabSampling.cginc` `SampleSceneEyeDepth` is a careful eye-depth read. It
  handles stereo instancing versus the side-by-side eye rectangle, the projection Y flip and
  reversed Z, and it marks sky and far-plane pixels invalid. Check its license before reusing code.
- **Hand Fitter** (Mag-Works, in Velle2025 `Assets/Mag-Works/おててふぃった～`, paid asset): avatar
  orthographic cameras rendering hand depth into their own targets. `HandFitterCapture.shader` draws
  only into its own camera (`_ScreenParams` must equal the data size, plus a camera-match test) and
  writes `unity_CameraToWorld`, the ortho size, near/far and `_Time` into its data.
  `HandFitterOwnership.hlsl` separates the local wearer from remote players. Learn from these
  patterns and write our own code; don't copy it.

## Facts that shape the design

- **The depth texture needs a shadowed directional light.** VRCFury SPS lights don't count: SPS
  bakes point and spot lights with `shadows = LightShadows.None`
  (`com.vrcfury.vrcfury/.../BakeHapticPlugsService.cs:310`). The debug avatar carries a black
  directional light with hard shadows and an empty culling mask. Measure what it costs: it turns on
  a depth pre-pass for the whole scene.
- **Only shaders with a shadowcaster pass appear in the depth texture.** Most world and avatar
  shaders have one. Some transparent or custom ones don't, and those are holes in our depth.
- **Exit channel: VRChat's desktop window.** In VR it shows an eye image without SteamVR overlays
  (lab memory: overlays are absent, and it switches to the camera feed in Stream mode). Which eye
  and what crop it shows is unknown; the block has to land inside it.
- **Lab ground truth:** `vrlab eye --layers` reads back what the driver was shown, VRChat's scene
  layer included (`CAPTUREDIRECTFRAME`). Decoded results can be checked against it.

## Design

### The debug avatar (Velle2025)

A separate debug variant of Velle (a new generated scene in `Assets/VRUnityGenerated/`, following
the vrunity hub rules: save drafts, snapshots, ask before committing to the project repo). It adds:

1. **The depth light** above.
2. **The exporter**: a mesh on the head with our shader. It runs in the eye pass, in `Overlay` late
   in the queue, `ZTest Always`, `ZWrite Off`, and draws only:
   - for the local wearer (ownership test), so nobody else sees the block;
   - in the stereo eye pass, not in mirrors, the VRChat camera or other cameras
     (`_VRChatMirrorMode == 0`, `_VRChatCameraMode == 0`, stereo matrices in use);
   - in the eye the desktop window shows, inside its visible crop.
3. **CustomObjectSync** (VRLabs 1.0.4, installed in Velle2025), which PetPlay already reads in
   `petplay/VRCOrigin.ts`
   (`/avatar/parameters/CustomObjectSync/{PositionX,PositionY,PositionZ,RotationY}`).

### The block format (version 1)

All values bit-exact: bytes go through `GammaToLinearSpaceExact`, as the bridge does. Check the
bytes before trusting them; don't assume they arrived intact.

- **Magic row**: the bridge's three words plus a format version.
- **Header**: frame counter and `_Time.y`, eye index, `_ScreenParams`, `_ProjectionParams`,
  `unity_CameraToWorld` and the projection for this eye, and a checksum.
- **Depth**: linear eye depth, downsampled (start at 128×128, 16 bits, log or 1/z encoded, one
  invalid code for sky). Pack two samples per three RGB bytes. The size is a parameter, chosen by
  how much of the window we can occupy and what survives.

The header's camera pose is in VRChat world space at float precision, every frame. Paired with the
OpenVR HMD pose for the same frame, it gives the VRChat world → tracking transform directly. That is
a check on CustomObjectSync, and possibly a replacement for it (see phase 3).

### PetPlay side

1. **Capture**: the VRChat window. In the lab, OBS window capture (`vrlab obs`) works first. Then
   PetPlay's own capture (`petplay-screen-streamer` / `ScreenCapturer`), which already captures
   windows for desktop overlays.
2. **Decode**: find the magic, check version and checksum, and unpack header and depth into a float
   buffer. Pure TypeScript, unit-tested against synthetic images rendered by the same encoding.
3. **Depth in the render**: the depth goes into the `webxr` raylib eye pass
   (`classes/webxrOverlayRaylib.ts`), as a texture with its eye pose and projection. Each overlay
   fragment compares its own eye depth with VRChat's, reprojected from VRChat's eye pose to the pose
   we render with. Where VRChat is nearer (with a bias and a soft edge), the fragment gets alpha 0,
   so the compositor shows VRChat through the hole. Head-relative depth plus our own HMD poses fully
   corrects rotation lag, and translation lag partly.

## Phases

Each phase ends with a measured result written into this folder.

0. **Offline (no upload, no VR).** Write the exporter shader and the TypeScript encoder/decoder. Run
   decoder tests on synthetic blocks, including sRGB round trips, scaling and corrupted blocks.
   Check the shader in the Unity editor (Play mode with a desktop camera and a depth light) with a
   render-texture readback. Done when a block rendered in the editor decodes to the editor's own
   depth and matrices.
1. **Avatar build.** The debug Velle variant with light, exporter and CustomObjectSync. SDK build
   checks pass. **User approves the one-time upload** (later updates of the same avatar ID also need
   approval).
2. **Lab: does the channel work?** `vrlab up`, switch to the avatar, capture the VRChat window,
   decode, compare with `vrlab eye --layers`. Measure:
   - bytes exact? (window scaling, world post-processing and bloom, MSAA, HDR)
   - which eye and crop the desktop window shows;
   - latency from VRChat's frame to decoded depth;
   - the depth light's GPU cost;
   - two or three different worlds, including one with post-processing.
3. **Coordinate sync.** The known CustomObjectSync bugs: sync sometimes only starts after a jump,
   and player rotation is sometimes wrong. Reproduce both in the lab (`vrlab tap Jump`, snap turns,
   joystick moves, teleports), then compare `VRCOrigin`'s origin with the one derived from the
   exporter's camera pose. Note the existing code's assumptions: a ±170 m position range
   (`(value - 0.5) * 340`) and yaw-only rotation.
4. **Integration.** A depth intake actor (capture + decode), the depth texture in the raylib eye
   pass, occlusion with reprojection. Check in the lab with a synthetic hand in front of a window
   (`vrlab hand`, `vrlab eye`).
5. **Headset.** User check on the real headset: occlusion edges during hand and head motion, the
   visibility of the block, and cost.

## Progress

### Phase 0 (2026-11-07)

- **Format v1**: `classes/vrchatDepth/format.ts` (reference encoder/decoder, 16 tests in
  `format.test.ts`) and `unity/PetPlayDepth/PetPlayDepthFormat.cginc` (the shader half). Beyond the
  design above it has a black quiet zone two cells wide around the grid. With one, stray background
  pixels plus the single black cell passed as a finder pair and shifted the origin. Header camera
  matrix is `UNITY_MATRIX_I_V` (view to world, camera looks down −z). The tests decode exactly on
  noisy backgrounds at 1/1/1 to 8/8/8 bits, through a gamma/contrast curve (6/6/6), after bilinear
  scaling by 0.5, 0.75 and 1.333 with 4-pixel cells, and from padded BGRA rows. They reject torn and
  damaged frames.
- **Prior art on encoding** (`research/TSMP-*`, MIT, kibalab): TSMP's frame is a block grid (8×8 px
  default, for video), a finder row, a header with CRC32, and per-codec calibration. RGB20 is 7/7/6
  bits per cell, with every level of every channel in a calibration region and nearest-level
  decoding. That is what our calibration copies. vrmodem's downlink (gray blocks, 2–8 levels, centre
  2×2 average) is the robust end of the same idea.
- **Exporter**: `unity/PetPlayDepth/PetPlayDepthExporter.shader`. Draws for the eye `_Eye` only, not
  in mirrors or VRChat cameras, and only when the camera is within `_GateRadius` of the head anchor.
  Block position and size are material properties (`_OriginX/Y`, `_CellPx`). Depth samples are
  texel-aligned with the eye target's rows; row order follows `_ProjectionParams.x` (cnlohr's rule),
  with `_FlipImageY` as a debug override.
- **Debug avatar builder**: `unity/PetPlayDepth/Editor/PetPlayDepthAvatarBuilder.cs`, installed into
  Velle2025 at `Assets/PetPlayDepth/`. It copies `Assets/SCENES/main.unity` to
  `Assets/VRUnityGenerated/Velle-PetPlayDepth.unity` and keeps only the active avatar. It clears the
  blueprint ID (a new upload slot), copies the expression parameters and menu, and adds:
  - a `PetPlay` submenu;
  - `PetPlay Depth/Local` (black hard-shadow directional light, exporter quad 0.25 m in front of the
    head on a VRC parent constraint), enabled by a Modular Avatar merged FX layer only when
    `IsLocal`;
  - CustomObjectSync on a root-level tracker.

- **Editor check passes** (`unity/PetPlayDepth/Editor/PetPlayDepthEditorCheck.cs` renders,
  `deno run -A utils/vrchatDepthEditorCheck.ts <dir>` decodes). Setup: Vulkan, a 1024² sRGB target,
  depth from the black shadowed light alone, a 64×64 grid at 6/6/6 bits and 2 px cells (a 264×74 px
  block). Results:
  - the block was found at exactly the drawn origin and pitch;
  - the view-to-world matrix is within 1.4e-7 of `Camera.cameraToWorldMatrix`, and the projection
    equals `GL.GetGPUProjectionMatrix` (m11 negative: the flipped render-to-texture projection,
    flags 3);
  - depth against raycast truth: relative error p50 0.055%, p90 0.15%, p99 0.30%;
  - 8 of 4096 samples over 1%, plus 2 sky/surface mismatches, all on object edges.
- **Found during the check:**
  - FastFur's editor GUI sets `_VRChatCameraMode = -1` outside VRChat, which turned the exporter
    off. The check resets both VRChat globals; in VRChat's eye pass they are 0.
  - The header checksum differed only in bit 31: the compiled shader hashed a zero projection term
    with a different sign from the one it sent (with FNV-1a, a sign-bit difference in any word
    changes only bit 31). Both sides now write −0 as +0 (`PPDFloatWord`, `floatBits`).
  - `ViewportPointToRay` starts on the near plane, so raycast ground truth must be measured from the
    camera position.
- **Builder output:** cost 253 of 256 parameter bits; the top menu has 6 controls including
  `PetPlay`. Each rebuild leaves another set of CustomObjectSync assets in
  `Assets/VRLabs/GeneratedAssets` (untracked; only the newest set is used).

- **Runtime controls, so phase 2 needs no re-upload:** local (unsynced, zero-cost) avatar
  parameters, settable over OSC as `/avatar/parameters/<name>`. Floats map 0..1 linearly onto the
  material range; the shader rounds them.

  | parameter                         | drives                          | range    | default |
  | --------------------------------- | ------------------------------- | -------- | ------- |
  | `PetPlayDepth/Enabled` (bool)     | block and depth light on/off    |          | on      |
  | `PetPlayDepth/OriginX`, `OriginY` | `_OriginX`, `_OriginY` (eye px) | 0..4096  | 64      |
  | `PetPlayDepth/CellPx`             | `_CellPx`                       | 1..9     | 2       |
  | `PetPlayDepth/Bits`               | `_BitsR/G/B`                    | 1..8     | 6       |
  | `PetPlayDepth/DepthSize`          | `_DepthWidth/Height`            | 16..512  | 128     |
  | `PetPlayDepth/GridWidth`          | `_GridWidth` (cells)            | 64..1024 | 256     |
  | `PetPlayDepth/Eye`                | `_Eye`                          | 0..1     | 0       |
  | `PetPlayDepth/FlipImageY`         | `_FlipImageY`                   | 0..1     | 0       |

### Phase 1–2 (2026-11-07)

- Uploaded by the user as `avtr_d7c602bf-91c3-4833-93f3-4617bfe118ae` ("avatar depth debug"). Later
  updates go through vrunity's headless `AvatarAgentBatch.Upload`, which updates the slot its
  PipelineManager names. Don't open the SDK panel or call `BuildAndUpload`: that showed the user a
  terms prompt again. Rebuilds keep the variant's blueprint ID (`blueprintKept` in the builder
  report).
- **First lab result (default lab profile, 532² VRChat eyes):** the block decoded from the headset's
  left-eye scene layer (`utils/vrchatDepthProbe.ts eye`, via `vrlab eye`'s `CAPTUREDIRECTFRAME`) at
  exactly the requested origin. Header: screen 532², near 0.001, far 1048, the synthetic symmetric
  projection, the camera's world position. 71% of samples had depth, 0.26–102 m.
- **VRChat here renders single-pass double-wide**, not instanced: flags lacked `STEREO_INSTANCED`,
  and the decoded depth showed both eyes squeezed side by side. Fixed by mapping depth UVs into the
  eye's half (`UnityStereoTransformScreenSpaceTex`) and subtracting the eye offset from
  `SV_Position.x`. A new header flag (8) marks double-wide.
- The lab moves to the `beyond75` profile (3562² recommended per eye, the user's BSB2e). Tunable
  ranges widened for it: DepthSize 16..512 (default 128), GridWidth 64..1024 (default 256), origin
  default (64, 64).

### Desktop window and the Stream camera (2026-11-07)

- **In VR, the desktop window is a centered crop of the left eye scaled by 0.7707** (3560² eye →
  1920×1000 window). The block decodes from the window at that scale with 6-bit channels (cells 2.31
  px); 8-bit fails calibration there. The finder now measures pitch over all runs, so 1–4 px runs
  still lock. But the block has to sit inside the crop, which on every headset means fitting it
  around the edges of the wearer's view, and the wearer sees it.
- **Direction for now: VRChat's Stream camera.** The exporter's `_Target` = 1 draws only in VRChat's
  camera pass (`_VRChatCameraMode != 0`) and sets header flag 16 (`VRCHAT_CAMERA`). In Stream mode
  the window shows the camera render 1:1 at 1920×1000, and the headset image stays clean (no block
  in `vrlab eye`).
  - Decoded with 8/8/8 bits at 1 px cells (calibration margin 1), depth 256² and 512² (grid 1024×174
    cells). Flags 19 (flipped, reversed-Z, camera).
  - The exporter is a SkinnedMeshRenderer with 2000 m authoring bounds on a head constraint.
    This alone does **not** establish reliable offscreen drawing in the client (see below).
- **OSC camera control works.** Open the camera from the Action Menu (`/usercamera/Mode` alone
  doesn't open a closed camera), then `/usercamera/Mode 2` for Stream. **`/usercamera/Pose` (x, y,
  z, rx, ry, rz in degrees) is writable**, although OSCQuery reports read-only access: writing
  `7.428 1.85 −4.472 / 0 237.74 0` moved the camera exactly there, read back from the decoded
  header. So PetPlay can place the camera itself: at the head, or flying in front of the view for
  denser depth (and possibly live 3D scanning), with reprojection into the eyes.
- Lab Action Menu picks need ~900 ms on the entry before the trigger in `beyond75` (`pickActionMenu`
  `holdMs`): stick to the entry, trigger while holding, release, stick neutral.

### Coordinate sync from the block (format v2, 2026-11-07)

- **`/usercamera/Pose` switches Flying on.** While Flying is on, locomotion input (sticks and
  `/input/Vertical`) moves the camera instead of the player. Set `/usercamera/Flying` false after
  every pose write. With this camera setup (Camera Anchor not on the player, which OSC can't
  change), the camera then stays fixed in the world while the player walks and turns, so it can't
  carry the player's motion.
- **The header carries the wearer's head instead** (`anchorToWorld`, words 27..38, format v2). The
  exporter quad rides a head constraint, so its own transform (scale removed, origin moved back to
  the head) is the head pose in every pass, including VRChat's camera pass: no eye-pass drawing
  needed. Editor check: anchor error 6e-8.
- **Lab:** with the camera fixed, the anchor followed a 4.8 m walk and an 83° turn. The left eye
  (eye-pass `viewToWorld`) stayed at a constant (−0.026, 0.067, 0.091) m from the anchor in the
  anchor's frame (right, up, forward). So head anchor plus the HMD's tracking pose gives world →
  tracking per frame, without CustomObjectSync.
- After an avatar re-upload, VRChat keeps the cached copy for `/avatar/change` to the same ID:
  switch to another avatar and back.

### PetPlay intake and alignment (2026-11-07)

- **Intake actor** `petplay/vrchatDepth.ts` (own process, on demand:
  `deno task client vrcdepth
  start|stop|status|set`): ffmpeg x11grab of VRChat's window
  (`classes/vrchatDepth/windowStream.ts`), decode, a 128² depth grid to `webxr` as `VRCDEPTHFRAME`.
  Decode ~15 ms per 1920×1000 frame. Use `-fps_mode passthrough`: ffmpeg's default constant-rate
  output duplicated frames whenever grabbing fell behind, and after a minute only ~1 of 52 window
  frames/s was a new VRChat frame. With it: ~42 new VRChat frames/s in the lab.
- **Alignment** (`classes/vrchatDepth/sync.ts`, in `webxr`): the block's viewpoint pose against the
  headset's tracking pose 50 ms before arrival gives world → tracking (yaw + translation), smoothed
  while the head is still and taken at once on jumps. It drives the VRC camera layer
  (`VrcCameraTracker.setDepthBlockPose`, replacing the grab calibration while blocks flow) and a
  debug wireframe of VRChat's depth in tracking space, with status lines printed in the layer
  window.
- **Lab check** (`_scratch/vrchat-depth/aligncheck.ts`: VRChat's real left eye from an eye-pass
  block, mapped to tracking, against OpenVR's left eye): with the head-bone anchor 11.3 cm off (6.7
  up, 9.1 forward: the bone-to-viewpoint offset), rotation 0.00°. With the anchor at the avatar's
  viewpoint (builder `anchorOffset` 6.7 up, 8.0 forward of the bone): **1.4 cm**, 0.00°.
- **VRChat scales the playspace**, world metres per real metre = `/avatar/eyeheight` ÷ the wearer's
  real eye height. Measured from VRChat's world IPD against OpenVR's 68 mm: eye height 1.274 m gave
  0.7854, eye height 1.6 m (written over OSC; `/avatar/eyeheight` is read/write) gave 0.9864: both a
  real eye height of 1.6220 m. VRChat's `PlayerHeight` pref was 1.7272 m, so the intake takes the
  real eye height as 0.9391 × `PlayerHeight` (`classes/vrchatDepth/vrchatScale.ts`, one height
  measured; `vrcdepth set --real-eye-height=<m>` overrides) and polls `/avatar/eyeheight` from
  VRChat's OSCQuery service (port from its log) every second.
- **With the scale: 1.4 cm, almost all along the view axis** (0.2 cm sideways, 0.03 cm up, 1.35 cm:
  VRChat's eye sits ~1.1 world-cm ahead of the descriptor's viewpoint). Rotation 0.00°.
- The original 1 px wireframe was nearly invisible at 3560 px per eye. The coloured surface and
  accumulated scan below replace it. The IR's `"custom"` material kind remains unused.

### Coloured depth and persistent 3D scan (2026-11-07)

- Standard Three `geometry.attributes.color` and `material.vertexColors` now travel through
  raythree's material IR into the raylib renderer. RGB/RGBA floats and normalized integer colour
  attributes are supported. This uses ordinary mesh geometry and materials, without a custom
  depth-rendering hook. The intake samples the Stream camera window's colour at each depth point,
  excluding the exporter block; unavailable colour is cyan on the live mesh and grey in the scan.
- `classes/vrchatDepth/voxelMap.ts` accumulates samples in VRChat world coordinates, with 4 cm
  cells, a 40,000-cell limit and a 12-world-metre range. It integrates at up to 10 Hz and rebuilds
  camera-facing surfel triangles at up to 4 Hz. The current world-to-tracking transform places the
  scan each frame, separately from rebuilding geometry. A paused scan keeps its previous views.
  Free-space observations carve old cells away; confidence is capped so long-observed moving
  surfaces can disappear within 31 contradictory observations (about 3 seconds at 10 Hz).
- Controls: `deno task client vrcdepth set --mesh=on|off` shows/hides only the live surface;
  `--scan=on|off` starts/pauses accumulation while keeping the stored scan visible;
  `--scan=clear` clears it without changing the accumulation setting. `--voxel=<world metres>`
  changes resolution and clears the old scan. To inspect only the live surface, pause then clear
  the scan. To inspect only the scan, use `--mesh=off`.
- **Lab verification:** a camera sweep through eight headings at two pitches accumulated 20,827
  cells; the live mesh was hidden and accumulation paused for the scan-only eye capture. Intake
  reported 36 distinct frames/s with no decode failures. Artifacts are under
  `_scratch/vrchat-depth/continue/` (local, gitignored).
- **Transparency finding:** at opacity 0.6 the live room surface was present in the direct raylib
  eye target but almost invisible in SteamVR's submitted layer. Full opacity made it visible in
  that layer; the debug material now uses full opacity. The underlying transparency discrepancy
  remains unresolved. Individual `vrlab eye --layers` images are flattened onto opaque black by
  the capture helper, so they do not preserve the original layer alpha.
- This is a sparse surface scan, with holes where depth is missing or sampling is too coarse.
  Surfel normals face their observing cameras rather than estimating the actual surface normal.
  Clear the scan after changing worlds; world identity/reset detection and automatic camera
  sweeping are not integrated. Overlay occlusion is still a separate next step.

### Exporter disappears when the camera looks away (2026-11-07)

- Ellie observed loss when the player leaves the camera view. A four-heading baseline at a fixed
  camera position reproduced it: yaw 90° decoded at 19.5 fps; yaw 0°, 180° and 270° lost the finder
  entirely. Reasserting an OSC pose facing the player can restore the block. This is source-image
  loss, not just decoder failure or overlay occlusion.
- `PetPlayDepthBoundsCheck.RunBatch` audited the actual SDK-preprocessed avatar: the exporter's
  renderer extents remain 1000 m on each axis both before and after preprocessing. Its underlying
  builtin quad mesh still has only 0.5 m extents. The build pipeline shrinking renderer bounds
  was ruled out in that audit; client-time recalculation remains a hypothesis.
- Candidate fix: the local On/Off clips now animate `m_UpdateWhenOffscreen = 0` and all six
  `m_AABB` centre/extent components on **only the four-vertex exporter**. The SDK preserves all
  seven bindings; sampling the processed clips restores a deliberately shrunken bound to 1000 m
  extents and disables offscreen updating.
- **Client check after the approved update:** switched to the previously used avatar and back to
  load the updated bundle, restored the exporter parameters, and repeated the exact fixed-position
  heading test. All four headings decoded: 20.5–21 fps, last-frame age 25–39 ms, no finder failures.
  This fixes the tested offscreen disappearance without expanding the body/clothing renderers.
  A further 12-second hold at the previously failing yaw 0°, with Flying off, remained live at
  20–21.5 fps and 24–36 ms last-frame age (`culling-hold-fixed.json`).
- Artifacts: `_scratch/vrchat-depth/flycam/bounds-before.txt`, `bounds-fixed.txt`, and
  `culling-baseline.json`, `culling-fixed.json`. The uploaded bundle was built successfully through
  `AvatarAgentBatch.Upload` and updated only the existing depth-debug slot.

### Interactive transparent debug view and timing (2026-11-07)

- **Desktop foreground prototype:** the interactive desktop overlay uploads the captured
  full 512² depth grid to an R32 texture and draws a color-masked fullscreen depth pass.
  Each valid sample writes OpenGL depth using the PetPlay projection and world-to-tracking scale;
  a 2 cm bias reduces surface flicker. PetPlay meshes and UI then depth-test against that buffer,
  leaving RGBA transparent where VRChat is nearer. UI keeps its existing no-depth-write ordering.
  Missing depth, missing alignment or a frame older than 500 ms disables occlusion. The captured
  header supplies the camera/projection for this render, including off-axis projection terms.
  Other desktop/headset renderer instances do not enable or allocate this pass.
- Debug controls: **O** toggles foreground occlusion, **V** toggles depth/head visualization,
  **C** changes visualization coloring, **B** freezes/resumes the lit crimson ball (creating
  it 2 tracking metres ahead if missing); **Shift+B** places a fixed 0.5 m orange cube. The ball follows
  position and direction during scene traversal, with no extra polling timer.
  `webxr VRCDEPTHDEBUGCUBE {enabled:false}` removes the object; `{lit:true,distance:...}`
  chooses a 0.3–20 m attachment distance, and `followCamera:false` keeps the ball fixed.
  `toggleFollow:true` freezes/resumes an existing ball without recreating its mesh. The B binding
  works in player and fly-camera modes; resuming restores the saved following distance.
  `vrcCameraView SETDEPTHFOREGROUND {enabled,visuals}` also controls the switches.
  These are runtime debug objects and are not restored on scene reload.
- GPU verification: `deno run -A --no-check utils/vrchatDepthForegroundProbe.ts` renders an
  offscreen RGBA target. Tests check near/far quadrants, vertical orientation, missing samples,
  a material that normally disables depth testing, a sub-texel plane intersection and a
  one-sample-wide 512² foreground feature. Camera tests cover translated, rotated,
  scaled tracking space and a flipped/off-axis source projection. Exact target images and live
  overlay exports are under `_scratch/vrchat-depth/foreground/`.
- **Foreground quality:** the initial 128² nearest-sample map produced visibly coarse cuts.
  The decoder now retains its full 512² source plane independently of the 128² debug/VR mesh.
  Each shared-memory slot has a separate foreground region; notices contain only its dimensions,
  and the cross-process VR wire frame still carries only the small grid. Storage is bounded at
  about 3.4 MiB for three slots. Reader snapshots and GPU uploads add roughly 1 MiB per new plane;
  no additional source decoding or 512² triangle construction is needed. Status/HUD report both
  resolutions so an unavailable high-resolution path cannot masquerade as the full map.
- The foreground shader reconstructs reciprocal depth between four neighboring samples only
  when all are valid and their depth range is within 6% of the nearest depth. This smooths
  projected continuous surfaces without mixing missing depth or large foreground/background
  jumps. At those edges it retains the nearest sample. This improves stair-stepping but cannot
  recover native 1080p silhouettes: the current avatar's depth-size parameter is capped at 512.
  The debug visualization remains 128²; this upgrade concerns foreground occlusion quality.
- A live 512² run with reconstruction showed 57 overlay fps, 109 ms median / 127 ms p90 over the
  latest 128 matched/presented camera commands, with no capture/command errors. These are observed
  movement samples, not a controlled before/after latency benchmark. Artifacts:
  `_scratch/vrchat-depth/foreground/quality-{128,512,512-smooth}.png`,
  `_scratch/vrchat-depth/speed/quality-512-live.json`. Decoder regression tests preserve a thin
  feature lost by the small mesh; a real worker test verifies both planes stay frame-consistent
  under overwritten notices, and checks that foreground arrays never enter the message metadata.
- **Capture buffering fix:** a fresh baseline had drifted to 535 ms median / 559 ms p90 command
  to window swap. Limiting rawvideo encoding to one thread initially reduced this to 137 / 161 ms
  (11/12 steps matched), but source timestamps subsequently exposed growing capture/pipe backlog.
  Bounding only the input queue and filter threading did not resolve it: a 24-step run still had
  393 ms median capture-to-arrival delay. The final path also bounds the output/mux queue and
  uses BYOB pipe reads directly into the reusable full-frame buffer, avoiding per-chunk
  allocation/copying. With these changes, all 24 steps matched at **101 ms median / 125 ms p90**;
  capture-to-arrival was **11 ms median / 18 ms p90**, without increasing across that run.
  Stage medians were 69 ms command-to-source capture, 4 ms decode, 0 ms shared-worker delivery,
  1 ms geometry preparation and 16 ms preparation-to-swap. Zero is below the 1 ms clock resolution.
  After more than a minute, a live movement sample of the latest 128 matched/presented commands
  remained at 93 ms median / 110 ms p90, with 11 ms median capture-to-arrival, 59 overlay fps and
  no capture/command errors. This sample excludes unmatched commands and is not an all-input
  latency distribution.
  Resolution, camera movement speed and the transparent window are unchanged by this fix.
  Artifacts: `_scratch/vrchat-depth/speed/{buffering-baseline,single-thread-capture,
  source-timed-capture,bounded-capture,direct-read-capture}.json`.
- Capture timing uses x11grab's wall-clock PTS, preserved with `-copyts`, and checksum-disabled
  `showinfo` frame numbers to correlate frames with arrival timestamps. Source time is just
  before the X11 read, **not** VRChat's GPU render timestamp; command-to-source therefore still
  includes actor/OSC routing, VRChat and presentation/capture scheduling. The parser retains at
  most 128 timestamps and rejects relative PTS; absent timestamps remain unknown. This adds
  `commandToSourceMs` and `sourceToArrivalMs` to `GETDEPTHLATENCY`. FFmpeg's
  [frame encoder implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/frame_thread_encoder.c)
  explains auto CPU-count threading and queued frame tasks; its
  [X11 grabber](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/xcbgrab.c) stamps wall-clock
  time before reading the image.
- **Initial command-to-window measurement, before the capture fix:** all 12 small pose steps matched their captured shader
  header, with 213 ms median / 228 ms p90 from desktop command dispatch to completion of raylib
  `EndDrawing`. Stage medians were 190 ms until matching RGBA frame arrival, 4 ms decode, 1 ms
  shared-worker delivery, 5 ms geometry preparation, and 12 ms until window swap. Individual
  medians do not add to the total median. Camera-actor acknowledgment was 15 ms median, a
  round-trip bound on actor handling/OSC submission, not VRChat applying the command.
  At that stage the dominant interval included command routing, VRChat applying/rendering the pose,
  and X11/ffmpeg/pipe buffering; the initial probe did not separate those components. Arrival time
  is stamped after the final frame byte is read, not when X11 captures it. These measurements
  exclude desktop compositor/display scanout and are a 12-step sample, not a sustained-motion
  benchmark. Results: `_scratch/vrchat-depth/speed/command-latency.json`.
- Repeat with `deno run -A utils/vrchatDepthLatencyProbe.ts --samples=12` while debug mode is
  active and RMB is released. The probe makes small camera steps, restores the starting pose
  and turns Flying off in cleanup. `GETDEPTHLATENCY` on `vrcCameraView` exposes bounded samples
  and per-stage summaries; `{reset:true}` starts a new run. Only a matching captured pose that
  actually reaches a window swap contributes a sample; unmatched/skipped commands are excluded.
- `deno task client vrcdepth debug` enables controls in the existing transparent VRC camera
  overlay; `--stop` restores its recording mode and mouse passthrough. Hold RMB for mouse look,
  WASD flight, Q/E vertical movement and Shift speed. C toggles depth/colour; R reasserts the last
  commanded pose after a source dropout. Releasing RMB restores player locomotion via Flying off.
  The layer keeps its position on mode changes; a newly created layer uses VRChat's window
  position/size. Actor reload snapshots preserve that position too.
- The first implementation presented the commanded pose while controlling, then the delayed
  captured pose on release, causing a disorienting correction. The debug camera now **always uses
  the pose belonging to the captured depth frame**, whether moving or stationary. The last
  commanded pose remains the input accumulator across gestures; it is not reset to delayed data.
- The intake sends compact depth frames directly to the overlay, bypassing `webxr` scene
  extraction, HMD alignment filtering and scene transport. The local debug scene reconstructs in
  VRChat world coordinates, including the magenta player-head/facing marker. Ordinary PetPlay UI
  continues through the scene transport; headset debug geometry is excluded from camera delivery.
- Decoder bit unpacking now copies channel-sized chunks instead of looping over individual bits.
  At the same 512² source depth / 128² debug grid, measured intake increased from 22 to 41.5 fresh
  frames/s and mean decode time fell from 18.4 to 8.5 ms. A live sample showed 25 ms since window
  capture arrival at the debug window (previous scene path: 84 ms). This age excludes VRChat's own
  render/capture latency and is **not** an end-to-end input latency measurement. No source-depth
  resolution reduction was used.
- Further tuning keeps small meshes indexed in raylib: the 128² grid now uploads 16,384 shared
  vertices plus 16-bit indices instead of 96,774 expanded vertices. Large meshes still expand
  safely when indices exceed raylib's 16-bit range; buffer tests cover both paths. The decoder
  additionally packs whole cells and precomputes sample addresses. On the same saved 512² block,
  30 warmed decodes fell from 7.68 ms median / 10.31 ms p90 to 3.72 / 5.13 ms; all 262,144 depth
  samples matched. Live sample medians were 5.58 ms decoding, 40 fresh frames/s, 24 ms since capture
  arrival, and 58 window fps. These measurements do not establish a further source-fps increase.
- Fly speed is now 3 world m/s by default (previously 1.5), adjustable with RMB + wheel; Shift
  multiplies it by four. Mouse sensitivity is unchanged. The earlier synchronization change did
  not reduce numeric travel speed, but removing predicted display could make it feel slower.
- **Shared-memory path:** debug mode now leases the single capture from the intake actor and runs
  `classes/vrchatDepth/captureWorker.ts` in a plain Deno worker inside the desktop process. Raw
  depth/colour arrays reach the renderer through three bounded `SharedArrayBuffer` slots, with
  small frame notices. Unread frames can be replaced; readers never see a partially written slot.
  The consumer takes one owned array snapshot for geometry staging. No JSON/base64 or host relay
  is involved between that worker and the debug renderer.
- VR-scene updates still cross a process boundary. Their wire conversion runs in the capture
  worker, with one outgoing request and one replaceable pending frame. The intake retains scale
  tracking, status and VR forwarding. Capture ownership has a heartbeat/expiry; stopping the
  debug worker returns capture to the standalone intake. Live disable/enable testing confirmed
  exactly one matching ffmpeg capture before, during fallback and after shared capture resumed.
- A plain worker is needed for current process placement, not actor semantics: Stageforge's
  `PostMan.create` routes worker creation to the host rather than into the requesting process.
  See [the child-worker issue](../issues/stageforge-cannot-place-worker-actors-inside-a-child-process/README.md).
  Tests cover overwritten notices, reader exclusion, bounded storage and actual concurrent
  worker reads/writes. The desktop GL process remains isolated from the headset renderer.

### GPU window capture: no ffmpeg (2026-11-07)

- VRChat (Proton) and PetPlay's raylib window both run under Xwayland on KDE Plasma Wayland, and
  raylib's GLFW makes a GLX context. `classes/vrchatDepth/gpuWindowCapture.ts` names VRChat's
  window pixmap with XComposite and binds it as a GL texture with `GLX_EXT_texture_from_pixmap`:
  no CPU copy of the frame, no portal dialog, no Vulkan layer (an injected layer would also be an
  anti-cheat risk). XDamage on a second X connection says when VRChat redrew (GLFW drains the GL
  connection's events). Xwayland **swaps the window pixmap on every present**: rebinding the first
  named pixmap gave 10 fresh frames/s of 42; naming the current pixmap per damage gives 42 of 42.
  A recording X error handler replaces Xlib's default, which exits the process.
- `gpuDepthSource.ts` per redraw reads back only the block's rectangle (0.75 MB) for the header,
  trailer and a nearest-sampled 128² grid (`decodeImage(..., { depthGrid })`, random access), and
  a nearest blit of the window to 128² for mesh colours. Measured per frame: bind 1.0 ms, rect
  0.7 ms, sparse decode 1.5 ms, colours 0.5 ms. The full-window readback (to find a lost block) is
  rate-limited to every 500 ms.
- The foreground shader (`FOREGROUND_BLOCK_FRAGMENT`) decodes every depth sample it needs straight
  from the window texture with the calibration LUT, so the full plane is never decoded on the CPU
  or uploaded. `utils/vrchatDepthForegroundProbe.ts` checks it against the texture path on encoded
  blocks (2×2 cases, 512² thin feature, 8- and 6-bit channels): 0 differing pixels.
- **Composite (F, default on):** the debug view draws the captured VRChat frame behind PetPlay, so
  image, pose and depth all come from one frame. Overlaying VRChat's live window instead always
  shows PetPlay behind by the capture delay: the rubber-banding seen while flying.
- Live: 43 decoded frames/s, 0 repeats/failures, 2.5 ms CPU per frame, 512² foreground, 57 view
  fps, ffmpeg not running. The VR scene still gets the 128² wire frame: the capture worker runs in
  `external` mode, forwarding frames posted by the render thread and keeping the lease.
  `SETDEPTHFOREGROUND {gpuCapture:false}` returns to the ffmpeg path.
- Seen while restarting the view: `vrcdepth debug` timed out after 30 s while the intake was
  running and responsive. Cause (2026-11-08): the agent REPL merged main's actor registry, so a
  closed `vrcCameraView` stayed in `/health` and the client sent `STARTDESKTOPVIEW` to a dead
  actor. Fixed in `agentRepl.ts` (the registry is replaced); takes effect after a server restart.

### Lighting record (format v3, 2026-11-07)

- The exporter pass is now `LightMode=ForwardBase` (`multi_compile_fwdbase`) so Unity fills the
  lighting inputs for its renderer, and the block carries a 130-float lighting record between the
  header (now 48 words, `H.lightingWords` at 39) and the depth (`format.ts` `LIGHTING`): probe SH
  (`unity_SHAr..SHC`), main light, the four vertex lights, ambient trio, fog, both reflection
  probes' HDR/box/position, the VRC Light Volumes scalars, and the renderer position. The block
  grows by 138 words; at the live layout (1024 cells, 512² depth) it stays 174 rows tall.
  `classes/vrchatDepth/lighting.ts` parses it into the right-handed world frame.
- Editor check (v3): depth and matrices as before; the record decodes with a unit main-light
  direction and ambient values. Reflection-probe box bounds are ±Infinity when a probe has no box
  projection (skybox): expected, not corruption.
- Live, this world: SH L0 (0.09, 0.07, 0.12), main light straight down with colour (1, 1, 1),
  no vertex lights, **Light Volumes off**. The white overhead main light is not yet explained: the
  avatar's own shadow light is black, so it is the world's light or a Unity default; check in a
  world with a known sun.
- VRC Light Volumes 3.0.1 is installed in Velle2025 (`Packages/red.sim.lightvolumes`). Its globals
  (`_UdonLightVolume` 3D atlas: three sub-boxes per volume hold L0 and L1 r/g/b; per-volume
  `InvWorldMatrix`, `UvwScale` ×3, `Rotation` ×2, `Color`, `InvLocalEdgeSmooth`; up to 128 point/spot/
  area lights at five float4 each) are readable by the avatar shader. Next: page the volume table,
  light table and atlas through a fixed block region, round-robin, and rebuild the atlas in PetPlay.
- After an upload the avatar's block parameters reset. The intake now re-asserts the layout itself
  (below); by hand: `utils/vrchatDepthProbe.ts set enabled=1 target=1 originX=8 originY=8 cellPx=1 bits=8 depthSize=512 gridWidth=1024`.
- Avatar Testing Chamber (`wrld_a5e9ec13-…`): **Light Volumes version 2, 5 volumes**, ProbesBlend
  1, SharpBounds 1; `_UdonLightVolumeEnabled` reads 0 (perhaps not set by v2). SH L0 ≈ 0.36, main
  light colour 0.

### 3D colour calibration and self-calibration (2026-11-07)

- **Cause.** In the Avatar Testing Chamber the block failed checksums in every frame although the
  window looked normal. Binning each channel's error against the other channels showed the world's
  post-processing mixes channels (red's error grows with green, blue's with red), plus dither (45 %
  exact, 46 % ±1, 9 % ±2) and white capped at 241. Per-channel ramps (1D calibration) cannot see
  crosstalk.
- **3D mode.** Bit 7 of preamble word 0's `bitsR` byte (`CALIBRATION_3D`) flags it. All channels use
  the same bits (≤ `MAX_3D_BITS` = 6); the block draws n³ calibration cells, cell k showing levels
  `(k%n, k/n%n, k/n²)`, and data cells decode to the nearest observed calibration colour
  (`colorCalibration.ts` `ColorClassifier`, bucketed search; reused across frames while the
  calibration matches). The GPU foreground uses a 64³ lookup table built in the capture worker
  (131 ms) and sent to the view. **4 bits** is robust under the chamber's grade; 5 bits is marginal
  (margin threshold 1.5 → `bad-calibration`). Editor check: 3D at 4 bits margin 17.
- **Controller** (`blockCalibration.ts`, driven by the intake once a second):
  - 1D at 8 bits by default; switch to 3D at 4 bits when a 5 s window has ≥ 5 corrupt decodes and no
    more clean than corrupt ones.
  - A new world (VRChat log "Entering Room:", `blockLayout.ts` `WorldWatcher`) goes back to 1D.
  - 15 s settle after each switch (VRChat applied parameters in 10–15 s).
  - The intake re-sends the full layout over OSC (`AvatarBlockLink`, normalized
    `/avatar/parameters/PetPlayDepth/*`) when nothing decoded for 10 s, at most every 30 s.
  - Counters restart when the debug view takes over the capture; a drop starts the window again
    instead of reading a negative difference.
  - Fixed policy: `vrcdepth set --calibration=auto|1d|3d` (`SETVRCDEPTHCALIBRATION`).
- **Live, chamber:** 47 corrupt vs 0 clean in 1D → 3D; after settling 26–28 decoded fps on the
  ffmpeg intake, 32–37 on the GPU path, 0–1 corrupt per 5 s; the debug view runs at about 55 fps.

### Measured grade, level inset, one depth sample per cell (format v4, 2026-11-07)

- **The chamber's grade, measured** from the 16³ 3D calibration cells over four live frames
  (`_scratch/vrchat-depth/chamber/grade/`; the mean is `classes/vrchatDepth/testdata/chamberGrade.json`):
  frame-to-frame noise sd 0.4 byte values, so there is no dither (the earlier "45 % exact, ±1, ±2"
  was the grade itself). Mid-tones pass almost unchanged (gain 0.94–0.97). Highlights roll off and
  cap at 240; saturated colours crush their weakest channel (under bright yellow blue levels 0 and
  1 both read ≈0) and lift red's low levels. Live 3D margin at full range: **2.0**; all ten closest
  pairs are bright yellows differing in blue level 0/1.
- **Bypassing post-processing**: VRChat has no supported way (world post-processing covers the
  whole camera image; a client toggle is an open feature request). TSMP's other codecs are the same
  family (RGB20/RGB16 per channel, Color256 = 3D nearest at 3/3/2 bits, Luma4); their robustness
  comes from 8 px cells averaged over 4×4, which depth can't afford, and they have no FEC.
- **Level inset** (`levelInset`, tunable `PetPlayDepth/LevelInset`): levels span
  `inset .. 255 − 2·inset`. Simulated on the measured grade (closest pair): 4-bit 3D 2.0 at full
  range → 8.8 at inset 16; 5-bit 3D 1.0 → 4.2. Per-channel (1D) decoding overlaps at any inset: the
  mixing is too strong. The decoder needs no inset (it matches observed calibration colours); the
  header carries it (word 41) for diagnostics.
- **One depth sample per cell, log-coded** over the cell's bits from `depthRef` (near, 0.05 m) to
  `depthFar` (word 40, 1000 m): a misread cell spoils one sample instead of flipping a high bit of a
  16-bit value that straddled two cells. Block size no longer depends on bits (512²: 256 rows of
  1024 plus head and calibration), so 3D at 4 bits is no longer twice the size of 1D; bits buy
  precision: 12 bits → 0.24 % steps (1.2 cm at 5 m), 18 bits → 0.004 %. The GPU foreground reads
  one cell per sample instead of two.
- Modes (`blockCalibration.ts` `MODE_LAYOUT`): 1D at 6 bits, inset 0 (four byte values between
  levels); 3D at 4 bits, inset 16.
- Checks: format tests decode through the measured chamber grade (1D fails, full-range 3D margin
  < 4, inset 3D exact with margin ≥ 7); GPU foreground probe 0 mismatches; editor check v4 1D ok
  (depth p50 0.006 %); editor check 3D inset 16: margin 13, depth p50 0.07 %.
- **Live, chamber (v4, 3D 4 bits inset 16):** margin 8.0; 0 corrupt decodes; ffmpeg intake ~25
  decoded fps; GPU path **44.5 decoded fps** (v3 3D: 32–37, 1D: 43), view 55–58 fps. Isolated depth
  outliers on smooth surfaces: 39 per frame, identical every frame, 37 of them a one-sample-wide
  pole 1 m in front of the wall: real geometry, no misread cells seen.
- **Capture lease drops (fixed):** the view kept falling back to actor-wire. The intake expires a
  lease after 4 s without a heartbeat or frame, and its expiry timer runs before queued messages,
  so any relay delay that long (worker → main's agent REPL → intake) ended the lease, and the view
  never claimed it again. Now: the intake re-grants a lease that expired to its owner when that
  owner is heard from again and nobody else claimed it, and logs expiries; the view retries the
  claim 3 s after a loss instead of staying on actor-wire; worker errors say what failed (HTTP
  status) instead of reporting every failure as "lease lost". `vrcdepth status` shows `lease`
  (expiries, last silence, re-grants, the intake's own longest event-loop stall); the view status
  has `captureLosses`. Watch after the fix: no losses, intake stalls ≤ 3 ms.

### Lighting PetPlay with VRChat's lighting, step 1: probe SH and main light (2026-11-07)

- `classes/vrchatDepth/environmentLighting.ts`: from the block's lighting record and the
  world → tracking alignment, the raylib lighting shader's environment: Unity's `unity_SHAr..SHC`
  unchanged, `_LightColor0` and the main light's direction (Unity world), and a 3x3 matrix taking a
  tracking-space normal to Unity's world frame (inverse alignment yaw, then z negated). The shader
  evaluates Unity's `ShadeSH9` exactly (L2 needs no rotation that way) and lights like ForwardBase
  diffuse, `albedo · (ShadeSH9(n) + _LightColor0 · max(n·l, 0))`, in linear colour. The world's
  lighting replaces PetPlay's own lights (with them added the test sphere saturated to white). Without
  a fresh block (5 s) PetPlay's lights and fixed ambient return.
- Live, chamber: a grey sphere (`VRCDEPTHDEBUGCUBE {lit: true}`) sits at the brightness of the
  world's grey surfaces, lit softly from above (L0 0.36, L1 up 0.2; no main light in this world).
- `/reload` of the webxr actor restarts raythree's asset ids while the debug view keeps its asset
  cache: new objects then draw with old geometry and materials (the sphere drew as the old cube).
  Restart the view after a webxr reload.
- One store per process: the webxr worker sets it on `VRCDEPTHFRAME`, the desktop debug view from
  its own frames. The experimental separate render owner (`overlayRenderOwner.ts`) doesn't get it.
- Not yet: reflection probes (specular), Light Volumes (paging the atlas through
  the block), VRChat's post-processing (PetPlay is composited after it, so it isn't graded).

### Point lights and desktop receiver shadows (2026-11-07)

- The lighting shader now evaluates the exported four vertex point lights with Unity's
  `Shade4PointLights` attenuation, transforming tracking-space positions back to Unity world.
  **B** places a crimson lit ball; **Shift+B** places the unlit cube.
- **H** toggles desktop shadows (default on). Lit opaque PetPlay meshes render into a 1024²
  directional shadow map; the receiver pass reconstructs VRChat surface positions from depth
  and darkens shadowed pixels with 3×3 PCF. It uses the main light when available, otherwise
  a dominant direction estimated from probe SH L1. SH-derived shadows are an approximation,
  not world shadow-map or Light Volume transfer. This currently shadows VRChat surfaces in the
  desktop view; it does not add receiving shadows to PetPlay's materials or headset composition.
- Fixed the initial live crash: shader `locs` is returned by the bindings as a numeric address,
  requiring conversion to an FFI pointer. Sparse UI slot cleanup also masked that original
  failure; cleanup now skips holes, and window-loop errors retain stack traces.
- Shadow depth is packed in RGB with opaque alpha. Packing depth into alpha let ordinary
  blending corrupt the map and caused speckled shadows. The GPU regression probe checks a solid
  receiver shadow (2176 changed pixels in its fixed scene) and exact restoration with shadows
  disabled. Run `deno run -A --no-check utils/vrchatDepthShadowProbe.ts`; its own framebuffer
  exports are under `_scratch/vrchat-depth/shadows/`. Lighting/frustum unit tests also pass.
- Desktop reload snapshots now preserve composite, GPU capture and shadow toggles.
- Initial capture-claim failures now retry too: the older retry covered only loss after a
  successful claim, leaving a reload that collided with an expiring lease on actor-wire forever.

### Spatial Light Volume prototype (2026-11-07; uploaded and live)

- `PetPlayLightVolumes.cginc` reads v2/v3 public volume transforms, edge falloff, color/rotation
  and the shared 3D atlas. Each volume is resampled onto a **16³ lattice** including the local
  bounds, retaining L0 and L1 (12 floats) in Unity world coordinates. The original atlas's
  coefficient packing, tint and L1 rotation are applied before transfer. The MIT license for
  RED_SIM's atlas/sampling conventions is included beside the exporter. This is a bounded
  sampled representation of diffuse volume lighting, not a byte-for-byte atlas copy.
- The existing v4 length-delimited lighting record grows from 130 to **1728 float words**:
  the base record remains intact, followed by a 1598-word spatial page. A page has a 12-word
  prefix (magic/version/count/additive/id/page/grid/probe-blend/sharp-bounds/LV-version/
  additive-overdraw/reserved), 48 metadata floats, 128 × 12 SH floats and an FNV-1a checksum
  split into two uint16-valued floats. `PPD_LIGHTING_WORDS` is updated; preamble v4 and depth
  encoding/resolution remain unchanged. GPU depth derives its start cell from the received
  lighting length, so older receiver code can still locate the depth payload.
- Pages advance at 20 Hz (32 pages/volume): one uninterrupted pass takes **1.6 seconds per
  volume**, or 8 seconds for five. Dropped/corrupt pages fill on later passes; actual convergence
  can take longer. Each page repeats transform/color/rotation plus a fixed atlas sample as its
  signature. Changes invalidate that volume; incomplete sets use the ordinary probe fallback.
  Valid complete sets are refreshed over later passes. Dynamic atlas changes during a pass
  are not an atomic snapshot; a change that misses the sentinel may mix until the next refresh.
- `lightVolumes.ts` assembles out-of-order pages with bounded storage (max 32 volumes), validates
  checksums/dimensions/finite values, rejects stale caches and clears after a long frame gap.
  Complete data is packed into a floating-point 2D texture. The lit-material shader samples
  trilinear spatial coefficients **per fragment**, evaluates the receiver's normal in Unity
  world coordinates, and applies regular-volume priority, edge/probe blending, sharp bounds,
  additive volumes and the additive overdraw cap. Main and Unity vertex lights stay separate.
  In legacy v2, Version/Count are used even when Enabled is absent (as in the testing chamber).
- Receiver code is loaded in both the normal WebXR process and the desktop view. Desktop status
  `lightVolumes` and `webxr GETLIGHTVOLUMES` report count, complete volumes, pending page counts,
  readiness and corruption. Existing process-isolation limits of the lighting store still apply.
- Verification: **79 depth tests pass**, including assembly, corruption, invalidation and
  owned snapshots; type-check passes. `utils/vrchatLightVolumeProbe.ts` verifies a gradient
  across one mesh, fallback outside bounds/reset, regular-volume priority, additive lighting
  and the overdraw cap in exact offscreen GPU renders. Unity's normal exporter render and a
  synthetic v2 atlas in 3D-calibration mode both decode; the latter verifies all 128 samples
  of a page against the known spatial gradient, tint, rotated L1 and checksum.
  Artifacts: `_scratch/vrchat-depth/light-volumes*/`, `light-volumes-spatial-gpu.log`.
- Ellie explicitly approved the exporter update, and `AvatarAgentBatch.Upload` successfully
  updated the existing depth-debug avatar. Switching away/back loaded it. Reasserting the
  chamber's established 3D calibration/inset restored decoding after the avatar parameter reset.
  Both desktop and WebXR assembled **5/5 volumes**, with no rejected volume pages observed.
  Across a 20-second ready-state observation, all samples remained ready; desktop fps ranged
  52–60 (typically 57), median GPU-source CPU decode was 6.81 ms. Before upload the view was
  about 55 fps. These are live observations, not a controlled performance benchmark.
- Coefficient inspection showed genuine spatial variation (e.g. one volume's red L0 ranged
  0..1.94, another 0.086..0.884). No hardware/display readback or full atlas dump was needed.
  The attempted live probe-only/spatial image pair is not a controlled comparison because the
  camera moved and the ball left view. Controlled offscreen comparisons remain the rendering
  evidence. `SETDEPTHFOREGROUND {lightVolumes:false|true}` supports desktop A/B tests and
  preserves the toggle across reloads; it does not disable the export or headset lighting.
  **L** also toggles this comparison. `lightVolumeStrength` (0..8, default 1) exaggerates the
  difference: `probe + strength * (spatial - probe)`, clamped at zero. Desktop strength was set
  to **3×** at Ellie's request to make the effect easier to see, then returned to **1×** after
  investigating a black crescent. This is debug contrast, not
  physically correct extra illumination, and does not affect headset lighting. The HUD shows
  readiness, spatial/probe-only mode and strength; strength survives view reloads. GPU checks
  verify zero strength reproduces probe-only pixels and boosted strength preserves fallback.
  The same-camera 1×/3× exports (`light-volumes/concern-{1x,3x}.png`) show the crescent disappears
  at 1×. At the inspected ball centre the red-channel spatial L0 was 0.304, L1 magnitude 0.159:
  unboosted irradiance stays positive for all normals there. Extrapolating from the avatar probe
  at 3× makes some normal responses negative and the clamp produces black. This is a contrast
  artifact, not a transferred shadow from the neighboring world cubes.
  The containing volume's inverse transform corresponds to 16×6×16 world metres: its 16³ lattice
  is spaced about 1.07×0.4×1.07 m. Sub-metre baked detail near the inspected cubes is therefore
  smoothed; volume transfer is verified, but accurate local occlusion detail is not established.
  Runtime artifacts: `_scratch/vrchat-depth/light-volumes-convergence.json`,
  `light-volumes-first-live.json`, `light-volumes-upload.log`, and `light-volumes/live-*.png`.
- Remaining: large-volume resolution tuning and further live visual testing.
  Light Volume runtime point/spot/area lights, cookies, shadow textures, specular and reflections
  are not transferred by this prototype. Spatial detail is limited to 16 samples per volume axis;
  a room-sized volume can therefore lose small baked occlusion details.

### Progressive Light Volume refinement (2026-11-07)

- The exporter now emits spatial-page version 2 with 16³ coverage followed by **32³ refinement**.
  Each sweep first sends 32 coarse pages for every volume, then 256 fine pages per volume.
  At 20 pages/s, five volumes need 8 seconds of coarse coverage and 64 seconds of fine data
  per 72-second cycle. Starting mid-cycle or dropping pages can delay convergence further.
  The 1598-word page and 1728-word total lighting record, depth resolution and cadence are
  unchanged; this trades cache warm-up time and storage for resolution rather than increasing
  per-frame payload size. A complete fine grid never gets replaced by later coarse refreshes.
- Receivers accept both old version-1 coarse pages and version-2 coarse/fine pages. Separate
  bounded assemblies publish per volume only when complete; old coarse lighting stays usable
  while fine pages arrive. The GPU metadata table carries each volume's dimensions and sample
  offset, allowing mixed 16³/32³ data without a shader variant or larger per-fragment stencil.
  Stale-completion thresholds now allow the longer sweep; a stopped data stream still falls
  back after five seconds. Metadata changes invalidate prior data at either resolution.
- The inspected 16×6×16 m volume improves from 1.07×0.40×1.07 m spacing to about
  **0.52×0.19×0.52 m**. This still cannot recover detail absent from the world's source atlas,
  nor does it add world-object shadow casting onto PetPlay. Strength remains at the normal 1×.
  HUD/status show how many volumes have reached 32³ independently of coverage/readiness.
- GPU regression confirms a narrow lighting feature blurred at 16³ survives at 32³ (fixed
  test pixel red 94 → 126), alongside the existing priority/blend/additive/fallback checks.
  Progressive assembly tests verify no temporary fallback or resolution downgrade. All **81**
  depth tests and type-check pass. A local Unity test variant samples a known 32³ atlas and
  verifies exported coordinates, tint, rotated L1, version/grid and page checksum; it is stripped
  from the normal avatar shader. Local texture packing measured 2.7–5.0 ms per completed update;
  the five-volume GPU texture grows from about 1 MB to 7.9 MB.
  Artifacts: `_scratch/vrchat-depth/light-volumes-fine-{fixture,gpu.log,pack-bench.json}`.

### Native Light Volume atlas transfer (2026-11-07)

Desktop player controls: **P** switches between fly camera and player mode. While the debug
window is focused, player mode maps WASD to locomotion, Q/E to turning, Space to jump, Shift
to run, left mouse to right-hand Use/trigger and G to right-hand Grab. Inputs reset on focus
loss, Escape, leaving the mode and normal shutdown. The camera remains a spectator camera;
Home returns it one metre ahead of the avatar. Movement releases camera Flying first, since
VRChat otherwise routes locomotion to the camera. These controls use VRChat's documented OSC
input endpoints, not the synthetic driver or physical controller overrides.

Legacy v0/v1 support reads `_UdonLightVolumeUvw[192]` min/max pairs instead of the v2/v3
`_UdonLightVolumeUvwScale[96]` representation. Local FastFur's bundled LightVolumes include
explicitly supports Enabled=1/Version=0 this way. Partybox reported 14 volumes, 11 additive,
and Enabled=1/Version=0; the earlier zero supported count was **not** evidence that it lacked
Light Volumes. Source SH channel packing, tint and rotation are the same in that legacy include.
The legacy native Unity fixture zeros newer UV globals and verifies the exported native texels,
so a mistaken modern-layout lookup cannot pass. All 85 depth tests and type-check pass.
This implements legacy baked diffuse SH; its separate occlusion atlas and runtime lights are
not yet transferred. Preserve that distinction when comparing the resulting lighting.
Uploaded via the existing debug avatar slot and reloaded in Partybox. Initial live observation
reports 14 volumes, valid native pages and zero corrupt volume pages. Full legacy cache warm-up
and visual parity remain unverified. A 300 ms OSC walking smoke test moved the head from
(-0.12,1.26,-245.66) to (-0.05,1.26,-245.52) while camera position stayed fixed, confirming
locomotion reached the player rather than the camera. Trigger packet press/release is covered
by UDP tests; world-specific interaction behavior still needs user testing.

- Spatial page version 3 replaces fixed 32³ refinement with the source atlas's actual,
  independent X/Y/Z dimensions. Coarse 16³ coverage still loads first. Native export includes
  the surrounding boundary texels used by the source's trilinear lookup, with explicit scale
  and half-texel bias. Tint and SH rotation commute with interpolation, so exporting transformed
  coefficients preserves the original baked diffuse field without endpoint resampling.
- The per-frame payload remains 128 SH samples. Initial loading time scales with native atlas
  size; completed volumes stay cached and are sampled on the GPU every render frame. A stopped
  stream still falls back after five seconds; changed metadata invalidates cached data. Dynamic
  atlas changes are detected by a centre sentinel rather than an atomic bake-generation ID.
- Native grids are bounded to 512 per axis, 4,194,304 samples per volume and combined native
  assemblies. Oversized grids report an explicit status/HUD limit and retain coarse fallback.
  This also bounds texture height and keeps float32 texel offsets exact. These limits are
  resource safeguards, not a claim of parity for every possible world.
- Receiver tests cover unequal axes, partial final pages and small native grids. Offscreen GPU
  rendering of a 34×14×22 boundary-padded field matches the analytic reference pixel-for-pixel.
  All 83 depth/lighting tests and `deno task check` pass. Unity's native fixture additionally
  checks the source texel centres, tint, L1 rotation and page checksum before upload.
- HUD reports native completion separately from coarse coverage. Normal strength remains 1×;
  amplifying contrast can create black clamping artifacts. This targets baked diffuse parity;
  runtime Light Volume lights/cookies, world shadows and reflections still require separate work.
- The first live native upload assembled all five chamber volumes: boundary-inclusive sizes
  66×26×66, 12×4×12, 22×4×21 and two 22×26×50 grids. The main source is 64×24×64 over
  16×6×16 m (0.25 m spacing). A complete sweep is 1513 pages / 20 Hz ≈ 75.7 seconds;
  joining mid-sweep and missing pages extended observed full convergence to about 3.3 minutes.
  All volumes then reported native, with no unsupported-size warning. The initial native shader
  reduced desktop frame rate to roughly 45–51; its scheduler was refactored to resolve
  id/page/phase together rather than repeatedly scanning every volume per exported value.
  The refactored native Unity fixture passed again before the follow-up upload. The final
  uploaded revision recovered roughly 56 fps and 8 ms decode during initial observation;
  avatar reload cleared the cache and started a fresh native warm-up. The final revision then
  completed all five native grids again with no runtime errors or size-limit warning;
  its 30-second observation measured 51–58 fps (median 55), median decode 7.4 ms.
  Artifacts: `_scratch/vrchat-depth/native-{editor,all-tests.log,gpu.log,final-convergence.json}`
  and `native-schedule-{upload.log,live.json}`.

### Animated volume metadata and driver interaction view (2026-11-08)

- Partybox animates the transforms and tint of two volumes. The former signature included both,
  so their assemblies repeatedly reset and global readiness stayed at 12/14 indefinitely.
  Spatial page protocol 4 exports **raw** SH texels; the receiver applies current tint/rotation
  on the GPU. Atlas signatures retain UV mapping and centre sentinels while treating transform,
  edge falloff, tint and rotation as live metadata. Metadata changes upload only the first 512
  texture texels, preserving the cached SH data. Previous protocols remain compatible.
- Coverage and native pages now alternate. Coverage retries therefore repeat independently of
  the full native sweep (14 volumes: 44.8 s per coverage cycle). Initial sampled native payload
  was 1792 pages / 20 Hz ≈ 90 s before coverage/retries; alternating coverage halves native
  transfer bandwidth. This fixes retry starvation, not the underlying payload-rate limit.
- Raw legacy Unity fixture verified texels/checksum. GPU raw tint/rotation matches baked reference
  pixel-for-pixel and tint animation is verified through a metadata-only upload. All 86 depth
  tests and filtered type-check passed. Uploaded to the existing debug slot, then reloaded.
  Live animated volume reached 291/342 native pages without resetting. The world subsequently
  changed its active volume set from 14 to 5; **all five reached usable coverage**, zero rejected
  pages observed, while native refinement continued. Full native completion remains unverified.
- The existing debug window has a **Show Driver / Show Stream** button; **I** also toggles it.
  Driver mode displays the presented VRChat left-eye layer, including camera UI and interaction
  prompts that the Stream camera omits. This is a bounded diagnostic readback using existing
  CAPTUREDIRECTFRAME raw files, with one request in flight and files removed after capture.
  It is slower than the regular GPU capture and includes the VRChat layer, not PetPlay's separate
  headset overlay layer. It does not launch another window. Driver readback performance is a
  known prototype limitation; native readback still captures both eyes/all layers internally.
- Driver view revealed the hand targeting the camera's Equip prompt. Player aim now compensates
  the synthetic Touch tip's -0.7 rad offset and places the origin beyond the viewfinder
  (tracking [0,1.6,-0.7]). P/enter-player and T restore it only for the synthetic lab; camera
  recovery saves the same pose. Mouse trigger now also sends the synthetic physical trigger,
  covering VRChat's normal Interact path in addition to OSC Use. Door activation after this
  change still requires user confirmation; do not infer success solely from packet delivery.
- A duplicate local variable in a preview reload caused PetPlay to exit during this work. It was
  fixed, type-check passed, and the existing service was restarted while VRChat stayed running.
  Depth intake, the single preview and calibration were restored afterward.

### Driver-eye display performance

I-mode performance update (2026-11-08): the driver now supports a selected eye/layer capture,
GPU-resized to 1024² before readback. The consumer uses this API, a private tmpfs directory
and no fixed 300 ms wait; older drivers retain a slower fallback. The approved SteamVR/VRChat
restart loaded the rebuilt driver and restored the same Partybox instance, calibration,
single preview and player controls. Live measurements: **~13 eye updates/s**, median **50 ms**
capture (35–81 ms), window 48–56 FPS. Before: 280 MB full dump / ~3 s per capture; after:
4 MB selected image. Exact render exported to `_scratch/vrchat-depth/driver-fast-live.png`.
Native ABI/transport/protocol tests and filtered type-check passed. The readback still copies
through host memory and is not a full-refresh GPU-sharing path. See the driver README for
the API and synchronization limits.

### VR occlusion, step 1: head-pinned Stream camera (2026-11-08)

The block only describes what VRChat's camera sees, so in VR the camera follows the headset.
`vrcdepth set --head-camera=on [--head-camera-offset=0.15]` sends the HMD pose through
`/usercamera/Pose` on every recorded HMD sample (about 63 Hz in the lab; `headCamera.ts` maps
tracking back to the VRChat world with the inverse of the block alignment). The camera sits 0.15 m
(tracking) ahead of the eyes so it doesn't render the inside of the avatar's head, and Zoom is set
to 18 mm, VRChat's widest (84.7° vertical). Measured live: camera 0.118 m ahead of the head along
its forward axis (0.15 × world scale 0.785), 0.0° between their view directions.

`vrcdepth set --occlusion=on|off` (on by default) draws the decoded depth surface into each eye
first, depth only (`VrcDepthOccluder` in `scene.tsx`, render order −1000, colour writes off), so
PetPlay's objects behind VRChat's geometry don't draw. It's a tracking-space mesh, so each eye
reprojects it from its own pose. Every vertex is pushed 2 cm further along its ray from the camera
(`updateOccluderSurface`), matching the desktop foreground's bias, so objects resting on a surface
aren't cut. The VRChat-camera calibration ball hides while the camera is head-pinned (it would
sit in the face).

Verified with `vrlab eye` in PartyBox: the lit ball 0.6 m behind the far wall is hidden with
occlusion on and drawn over the wall with it off; in front of the wall it draws normally.
The accumulated scan (`vrc-depth-scan`) still draws after `--scan=off`; use `--scan=clear`
before judging the headset view.

Known limits: the surface is one frame of the 33 Hz block plus about 50 ms of latency, so it
trails fast head turns; edges lose a cell where discontinuities are cut; outside the camera's
field of view there's no occlusion. Option 2 (an eye-pass block read from the mirror texture)
would fix the trail.

### VR-only cost: GPU capture helper and a lighter wire (2026-11-08)

Measured in the lab (synthetic driver, PartyBox) with no desktop view open, CPU from `top` over
6 s, GPU from amdgpu fdinfo (`_scratch/perf/gpuproc.py`), JS from V8 profiles (`PROFILECPU` on
desktopView, `captureCpuProfile` through webxr `/eval`), native from `perf-petplay`.

- Without the debug view the intake fell back to ffmpeg x11grab plus a full-window CPU decode:
  22 ms per frame, 26 fps, plus ffmpeg. `STARTVRCDEPTH` now also starts a hidden `desktopView`
  in `captureOnly` mode (`gpuCapture: false` opts out): the texture-from-pixmap capture, no
  drawing, no scene view. It claims the lease as a *background* owner; the debug view's claim
  preempts it (`lease.preemptions`) and the helper takes it back after the view releases.
- Each frame crossed four JSON hops (capture worker → agent REPL HTTP → intake → webxr) as base64
  float32 depth and RGBA colours, ~175 KB at 40 Hz. Depth now travels as 16-bit log codes
  (`DEPTH_LOG16`, 0.02 % step) and colours only while webxr's debug mesh or scan use them
  (`VRCDEPTHWANTS`); without colours the helper also skips its second blit and readback.
- The occluder builds positions and a 16-bit index only (it had reused the coloured debug
  surface: ~20 % of a core in webxr, now ~3 % including upload).

| (VR-only, depth on) | before | after |
| --- | --- | --- |
| PetPlay main process (webxr worker, relays) | 67 % CPU | 35 % CPU |
| capture (ffmpeg path → GPU helper) | 22 ms/frame decode | 18 % CPU at 26 fps |
| intake | | 3 % CPU |
| GPU: helper / old debug view | 2.0 % | 0.8 % |
| GPU: occluder on vs off | | within noise (8.2 vs 8.4 %) |

The helper decodes every VRChat present (damages = decodes); 23–40 fps here is VRChat's desktop
window rate. What remains in the helper: block decode in JS (~6 %), forwarding (~4.5 %), the
2 ms poll loop and FFI (~4 %). The block readback (`readRect`) still blocks ~8 ms of wall time
per frame waiting on the GPU queue (not CPU): an async PBO readback would free that thread.
PetPlay's main GPU share (~8 %) is mostly the overlay itself (two 3560² eyes into a 7120² stacked
panorama), not depth. `vrcdepth debug --stop` leaves the VRChat camera layer window running
(`STOPVRCCAMERAVIEW` closes it).

### VR: depth decoded where it's drawn (2026-11-08)

Default for VR since `3bb55e3` (`cpu-gpu-audit.md` has the measurements). The webxr render thread
binds VRChat's window itself (`headsetDepthSource.ts`, two texture slots of
`gpuWindowCapture.ts`). Each redraw is bound into the slot not being shown and its block
rectangle is read back through a pixel-pack buffer and a fence, never waiting on the GPU. Only
the header is decoded on the CPU (the 128² grid too while the debug mesh or scan is on); once it
validates, that slot becomes the shown one, so camera pose and depth are always one VRChat frame.

The occluder (`OCCLUDER_VERTEX`, drawn first and depth-only in each eye by
`WebXRRaythreeRaylibRenderer.setDepthOccluder`) is a fixed 127² grid of unshared triangles. Each
vertex decodes its triangle's three samples from the window texture with the foreground's GLSL
(1D LUT or 3D table), unprojects as `unprojectDepth` and moves into tracking with one matrix.
A triangle with a missing sample collapses; one across a depth edge takes its farthest sample,
so the background runs under silhouettes instead of leaving a one-cell gap (the CPU occluder's
behaviour). The 3D calibration table builds in `tableWorker.ts`.

The intake ranks capture leases: debug view (3) > headset source (2) > GPU helper (1). While the
headset source holds the lease no helper or ffmpeg runs; its heartbeats carry decode health for
block calibration, and the intake sends its id, running state and world scale to webxr every
second (`VRCDEPTHINTAKE`, `VRCDEPTHSCALE`). The debug view still captures for itself and takes
the lease; the headset source keeps running and claims it back after.
`vrcdepth set --headset-decode=off` returns VR to frames relayed by the intake.

Checked in the lab with `vrlab eye`: the lit ball 14 m out, behind PartyBox's back wall (12 m),
is hidden with occlusion on and drawn over the wall with it off. A test ball "behind the wall"
at 10 m was in fact in front of the back wall and behind a 9.3 m edge below it: measure the
decoded surface along the ray before reading a capture.

### The avatar's own depth camera (2026-11-08)

The Stream camera stays the way out (the window shows its pass), but the depth no longer has to be
its own. The builder puts a **Depth Camera** on the debug avatar: a child of the exporter at the
viewpoint (the anchor), with the exporter's rotation, 110° vertical × 1.25 aspect (~121°
horizontal; a Quest 3 eye is ~96° vertical), near 0.05 m, far 500 m, rendering scene depth into
its own 640×512 Depth-format render texture (`Generated/DepthCamera.renderTexture`), camera depth
−50 so it renders before VRChat's camera. Culling: everything but UI, UiMenu, MirrorReflection
and InternalUI. The exporter (`_Source` 1) reads that target in the camera pass instead of
`_CameraDepthTexture`, at the centre of the texel under each sample (at most half a texel, ~0.09°,
off the sample's ray), and writes the depth camera's pose (the anchor frame looking down its +z)
and symmetric projection into the header, with flag 32 (`FLAG_DEPTH_CAMERA`).

- `PetPlayDepth/Source` (local, default 1, also in PetPlay's `DEFAULT_LAYOUT`) switches it: the
  depth camera is active only as the source, and the shadowed depth light only when it isn't (the
  light costs VRChat a depth pre-pass and shadow map for every camera).
- PetPlay stops pinning VRChat's camera while blocks carry flag 32 (`vrcDepth.depthCamera`), so
  no `/usercamera/Pose` writes, no Flying; VRChat's camera only has to be open in Stream mode,
  anywhere. Colours from the window are off for those blocks (the window shows another view).
- The exporter never draws inside the depth camera's render (its screen size equals the target's).
- Editor check (`PetPlayDepthEditorCheck -petplayDepthAvatarCamera`): pose and projection exact
  (6e-8), depth error p50 8e-6, p99 0.19 %, no validity mismatches. Sampling the raw sample
  centre instead failed (p50 0.22 %): with 64 samples over 640 texels every centre fell on a
  texel edge.
- Live on a Quest 3 (2026-11-08): after reloading the avatar, blocks carried flag 32 (header fov
  110°, camera at the head), the headset occluder drew, ~33 blocks/s decoded, and PetPlay sent no
  camera poses (0 in 5 s; it had been sending ~90/s).

### GrabPass between the eye and camera passes (2026-11-08): no

Could the eye's own depth reach the Stream camera feed without a second scene render? Tested with
`unity/PetPlayDepth/PetPlayGrabShareTest.shader` on the debug avatar (local toggle
`PetPlayDepth/GrabTest`, off by default) and `utils/vrchatGrabShareProbe.ts`, live on a Quest 3:
the eye pass draws a checker in each eye's top-left corner, then `GrabPass { "_PPDShareTex" }`;
the camera pass shows the grab, read as a texture array and as a 2D texture. Result: the reference
patch drew; the array read was Unity's flat grey default (nothing bound); the 2D read was the
camera's own image (mean difference from the scaled camera image 21 levels, against 64 for the
grey), with no checker. Each camera takes its own named grab, so nothing from the eye pass
reaches the camera pass this way. Next: an avatar camera rendering depth into a render texture
(Hand Fitter's pattern), read by the exporter in the camera pass.

### Any camera and window resolution (2026-11-08)

The lab ran VRChat's Stream camera and its desktop window both at 1920×1000, so the block's
1-pixel cells reached the capture intact. With any other pair the window resamples the camera
image, and a smaller window shrinks cells below a pixel. `blockFit.ts` sizes the block for what
the capture sees: 1-pixel cells only at exactly 1:1, otherwise cells of at least 2 window pixels
(2.3 px cells decode in the lab), then the widest grid and largest square depth plane that keep
the block inside the camera image and under 35 % of its height. The intake refits from the
camera size in decoded headers (`screenWidth/Height`, also sent by the headset source's
heartbeat) and the captured window's size, 15 s after the last layout change; while nothing
decodes for 10 s it probes window scales 1, 0.75, 0.5 and 0.33 in turn. 1920×1000 at 1:1 keeps
today's layout (1 px, 1024 wide, 512²); a 1920×1080 camera in a 1280×720 window gets 3 px cells,
634 wide. `vrcdepth status` shows `calibration.fit`, `cameraSize` and `window`.

The head camera's coverage is VRChat's widest zoom: 84.7° vertical, the horizontal following the
Stream aspect (~123° at 16:9). A Quest 3 eye sees about 96° vertically, so the top and bottom
edges of the view have no occlusion.

### CustomObjectSync findings (VRLabs 1.0.4)

- `Generate()` copies the FX controller but **edits the descriptor's expression parameters and menu
  assets in place**. Any variant sharing those assets would get its parameters, which is why the
  builder copies them first.
- It adds an **"Enable Custom Object Sync" toggle** (`CustomObjectSync/Enabled`). Sync does nothing
  until it is on. PetPlay may need to set it over OSC; check this against the "had to jump before it
  worked" reports.
- Without quickSync, a position parameter `v` in 0..1 means `(v − 0.5) · 2^(maxRadius + 1)` metres.
  `VRCOrigin.ts` uses `(v − 0.5) · 340`, which matches no `maxRadius`. The debug avatar uses
  `maxRadius = 8` (±256 m), yaw only (`syncRotationX/Z = false`).

## Open questions

- **The block is in the headset image.** Anything the eye pass draws, the wearer sees. Options: the
  smallest block that works, at the edge of the view the desktop window still shows; the hidden-area
  mesh corners if the window shows them; or drawing only in the VRChat camera's Stream pass, which
  doesn't reach the headset but has the camera's depth, not the eye's.
- **Second approach: an avatar camera.** An avatar camera on the head, rendering a depth target as
  Hand Fitter does: no depth light, a chosen culling mask (players only, for hand occlusion), but a
  second scene render, and its pose is near the eye but not exactly it.
- **Safety settings.** How VRChat's shader blocking and avatar performance ranking affect our own
  avatar locally, and whether a remote player with the avatar shown could still run the exporter.
- **Desktop window size.** VRChat's window resolution and any scaling between its render and the
  capture decide whether one block pixel stays one pixel.


## Remote AR keying integration (2026-11-15)

The live scene can contain a key-colour sphere for the remote AR browser; see
[../webxr-client.md](../webxr-client.md#live-scene-key-and-vrchat-depth-2026-11-15).
Depth-only display proxies leave holes for their separate SteamVR overlays. VRChat's
camera depth shares that buffer, so nearer VRChat surfaces also mask the key.

The headset occluder now samples the full encoded depth plane in a fullscreen fragment
pass (`OCCLUDER_PIXEL_FRAGMENT`), rather than resampling through a 128² triangle grid.
It reprojects each eye ray into the captured depth camera, refines the intersection three
times, and discards missing/out-of-view/unconverged samples. It shares the foreground's
continuous-surface filter (reciprocal depth interpolation, nearest sample across edges).
The native hidden-window test retains a one-pixel 512² feature with the legacy grid field
still at 128. Single-view disocclusions and source resolution remain limits.
