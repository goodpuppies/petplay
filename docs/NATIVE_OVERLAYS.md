# Native overlays: UI panels and 3D groups as SteamVR quads

PetPlay normally draws its whole scene into one stereo image and shows that glued to the head (the
panorama, see [PROJECTION_OVERLAYS.md](PROJECTION_OVERLAYS.md)). SteamVR then knows nothing about
where a window is: any gap between the head pose PetPlay rendered for and the one on display moves
every window with the head. Rotation can be reprojected (projection mode); translation cannot, the
image has no depth. Bouncing or swaying is pure translation, so windows visibly lag behind.

A **quad overlay** does not have that problem. SteamVR is told where the rectangle is and redraws
it for the newest head pose at display rate, however rarely the owner updates it. The desktop
screens have always been quads, which is why they hold still while the UI around them does not. A
quad's texture is also sampled once, straight into the display image, where panorama UI is
rasterized in perspective into the eye image, resampled into the panorama and resampled again for
the lenses.

`overlayPresentMode: "native"` (Settings → General → Overlay Mode → NATIVE) moves everything that
is normally on show out of the panorama:

| Content | How it is found | Shown as |
| --- | --- | --- |
| every uikit root (keyboard, toolbars, wrist menu, toasts, Settings window, …) | automatically | one quad each; its texture is redrawn only when the picture changes |
| a grab box's outline (the blue frame around a window) | `userData.nativeStereo` with `box` and `withPanels` on its twelve bars | one stereo quad lying in the box's nearer face; redrawn only when the eyes have moved enough to show |
| any other group of meshes | `userData.nativeStereo` on each mesh, `userData.nativeStereoCenter` on the centre | one stereo quad facing the head, redrawn every frame |
| a laser beam, a cursor dot | `userData.nativeQuad` on the mesh (`beam` or `flat`) | one plain quad each, drawn once: a beam's lies along the beam, faces the head and rides the controller; a dot's lies in the dot's plane |

Panels are native only in `native` mode, and only with the decoupled renderer (the default on
Windows and Linux). Stereo groups marked `withPanels` and the pointer's meshes go with them; other
stereo groups are shown natively in every present mode.

What the panorama still draws in `native` mode: the chrome of edit layout mode (snap slot markers),
debug visuals (the orange test cube among them), the display's rear logo, and the panels'
backgrounds as depth only.

## Panels

A uikit root is flat by construction, and **its own world matrix maps the unit square
(-0.5..0.5 in X and Y) exactly onto its rectangle**, whatever its size, pixel size or parents'
scale. Its Z column carries no usable length. So nothing has to be marked: the extractor
describes every root that draws anything.

```text
scene worker                              renderer process (overlayRenderOwner)
────────────                              ──────────────────────────────────────
extractWebXRRaythreeUi                    planNativeContent(payload)
  per root with items:               ──►    eye payload: UI without those roots
  ui.nativePanels[{key, rootIndices,                + their backgrounds as depth only
     worldMatrix, pixelWidth,               per panel: its items + camera
     pixelHeight, renderAnchor}]          renderRaythreeFrame(eye payload)      eyes, as before
                                          NativeOverlayLayer.present
                                            content hash changed? renderNativePanel → texture
                                            OpenVrNativeOverlays.present → SteamVR quad
```

- **The scene only describes.** Items stay in `ui.panels/texts/images`, so the desktop view and
  any other consumer draw them as before. `nativePanels` travels in the wire format and the scene
  fingerprint. A root's key (`ui-<n>`) is its own for as long as it lives.
- **Opting out.** `userData.nativePanel = false` on an object keeps the roots under it in the eye
  image. The display's rear logo does: it relies on backface culling to stay hidden from the
  front, and lies in the plane of the screen's own quad.
- **The panel camera** (`nativePanelCamera`) is orthographic over the unit square of a frame built
  from the root matrix's X and Y columns and their unit normal. Items keep their world matrices.
  The texture has at least `nativeTexelsPerPixel` (2) texels per uikit pixel, capped at 4096; its
  size is rounded up to a step each way (see [One overlay, one texture size](#one-overlay-one-texture-size)),
  and the quad's texel aspect makes up for the few percent that takes the texels off square.
- **Redraws** follow `nativePanelContentHash`: everything drawn, placed relative to the panel.
  Items riding the same tracked space as their panel are placed by their anchors' local matrices,
  which stay bit-identical while the hand moves; world matrices rebuilt from tracking every frame
  carry float noise that would redraw a wrist menu constantly.
- **Where the quad goes.** A panel in the room gets an absolute transform. A panel that rides one
  tracked device (parented to a hand or the head, or carried in a one-handed grab) is
  **attached to that device** (`nativePanelAttachment`): SteamVR composes its place on the device
  with its own newest pose at display rate. Two-handed grabs, and a released grab held in place
  until the scene catches up, are placed in the room each frame.
- **No calls while nothing changes.** A transform is sent only when it moved by more than float
  noise, a picture only when its hash changed. A panel that stays put, or rides its device,
  costs nothing per frame.
- **Coming and going.** A panel that leaves the scene (a wrist menu turned away, a toolbar
  deselected) has its quad hidden and kept for about ten seconds (900 frames, at most 16), with
  its texture and hash, so coming back is one `ShowOverlay`. After that its SteamVR overlay is
  kept as a spare for the next picture of the same size, and its textures likewise.
- **Order.** Quads sort far to near among themselves and with the desktop screens (sort order 0);
  the panorama sorts above them (1), and the pointer's quads above that (2 and 3). Each native
  root's background stays in the eye pass as a depth-only panel (`ui.depthOnlyPanels`), so what
  the panorama still draws behind a panel is hidden.
- **Failure.** Any error in the native pass sets `nativeError`, removes the quads and returns
  everything to the eye image from the next frame; the headset shows a toast. Selecting NATIVE
  again retries.

## 3D on a quad

A quad is flat, but with `VROverlayFlags_SideBySide_Parallel` SteamVR shows the left half of its
texture to the left eye and the right half to the right. Each half is drawn with an **off-axis
frustum through the quad's rectangle from that eye's real position**. Each eye then sees every
point of the group in its true direction (`nativeOverlayMath.test.ts` checks exactly that), so the
group has real depth and parallax.

What SteamVR locks is the rectangle. The picture inside is right for the eye positions it was
drawn for. A point `z` in front of or behind the quad's plane, seen from distance `d`, is off by
about `movement · z / (d − z)` once the head has moved: for a 15 cm cube at 1 m and 2 cm of head
movement about 1.5 mm at the cube's nearest corner and nothing at its centre, against 2 cm for
the same cube in the panorama.

Two kinds of quad:

- **Facing the head** (`nativeStereoQuad`): a square through the group's centre, turned to the
  head. Its frame changes whenever the head moves, so it is redrawn every frame. For free-standing
  groups; Settings → Debug → Test Cube shows one (teal) beside the same cube in the eye image
  (orange).
- **In a box's face** (`nativeStereoBoxQuad`): for a grab box's outline. The quad lies in the
  box's nearer face and never turns, so the nearer frame, which is all of the outline that is not
  hidden behind the panel, lies in the quad's own plane and is held exactly by SteamVR. Only the
  far frame, `depth` behind, depends on the eyes, so the picture is drawn again only when an eye
  has moved more than `redrawAfter` (at least 2 mm; 0.3 mm of error on the far frame) or the bars
  changed. A box carried by a hand rides that hand's device like the panel inside it. The panels'
  backgrounds are drawn into the picture's depth first, so the far bars are hidden behind the
  panel as in the eye image. Seen too much from the side (an eye closer to the face than the box
  is deep, 8 cm at least, or the far frame sliding out of the quad), the outline falls back to a
  head-facing quad.

## The pointer on quads

Once the panels hold still, a laser drawn into the panorama visibly sways against them. A laser
beam and its cursor dot are thin and flat enough to be plain quads themselves
(`userData.nativeQuad`, `nativeMeshQuad`); no second eye's picture is needed, SteamVR draws the
quad where it is for each eye.

- **A beam** (`shape: "beam"`, long along its local Z) gets a quad that holds the beam's axis and
  turns about it to face the head, four beam widths tall. Its picture is drawn looking at one of
  the beam's own faces, so it never changes: a band across the middle quarter of the texture from
  end to end, whatever the beam's length or roll. It is drawn once; after that only the quad's
  width, texel aspect and transform follow the beam. The texture is 16 texels tall, one texel a
  quarter of the beam's thickness, which the bilinear filter turns into a soft edge.
- **A beam in a hand's ray space is attached to that controller**, like a panel on a hand:
  SteamVR moves it with the hand at display rate, where the panorama showed the hand's pose of
  the last rendered frame. Its length still follows the scene.
- **A dot** (`shape: "flat"`, in its local XY plane) gets a square quad in that plane, a quarter
  larger than the dot, with a 64 x 64 picture drawn once. It moves when the scene moves it and
  holds still against the panel in between.
- **Beam textures come in four lengths** (64, 256, 1024, 4096 texels by 16), the one nearest to
  square texels for the beam's length, kept until its texels are more than 2.5 times off square
  so a length hovering at a boundary does not swap overlays every frame. A single texture would
  need a texel aspect of 150 for a 2 mm beam of 1.2 m; whether SteamVR honours an aspect that far
  from 1 could not be measured, and within a factor of two a wrong guess only makes the beam a
  little thicker or thinner.
- **Order, not depth.** Beams sort above the panels and the panorama (2), dots above beams (3);
  with the SteamVR dashboard open they drop to 0 with the panorama. A panel in front of a beam no
  longer covers it.

## One overlay, one texture size

Measured on SteamVR 2.18.4 with OpenGL textures (`tests/native_overlays/steamvr_handle_probe.ts`,
which asks SteamVR for the picture it holds with `IVROverlay::GetOverlayImageData`):

- **An overlay's picture keeps the size of the first texture it was given.** A texture of
  another size is accepted without an error and never shown as it is: one at least as large both
  ways is cut down to its lower-left corner of the old size, one smaller either way is not taken
  at all and the overlay goes on showing its last picture.
- Nothing resets that: not `ClearOverlayTexture`, not `SetOverlayRaw`, not hiding the overlay.
- Destroying the overlay does not either. The size belongs to the overlay's **slot** (the low 32
  bits of its handle), `CreateOverlay` hands a freed slot to the next overlay, and that overlay
  treats a texture of another size the same way. Only the process
  ending clears it; another process may use the slot at any size.
- The OpenGL texture's number plays no part: a number freed and handed out again at another size
  works on an overlay whose slot is new.
- `GetOverlayTextureSize`, called right after `SetOverlayTexture`, reports the size SteamVR
  really holds, so the mismatch can be seen at once.

This is what made the first headset build show the keyboard's picture, split between the eyes, on
the test cube's quad. `OpenVrNativeOverlays` therefore ties every SteamVR overlay to one texture
size:

- A quad whose picture changes size moves to another overlay; the new one is shown before the
  old one is hidden.
- An overlay no quad needs is **parked**, hidden, for the next picture of its size (16 at most;
  beyond that the one that has waited longest is destroyed).
- After an overlay's first texture, SteamVR is asked what it holds. An overlay that turns out to
  belong to another size (its slot was used before, by anything in the process) is parked under
  that size and the next one is tried (`sizeMismatches` in the health readout).
- **Texture sizes come in steps** (`nativeTextureSize`: 64 texels up to 2048, 128 above, rounded
  up, each way on its own), so panels of nearly the same size share overlays and a window being
  resized passes through a handful of sizes. The picture always fills its texture; the quad's
  texel aspect makes up for texels that are not square.

SteamVR has room for 128 overlays, all programs together, which is why spares are limited.

## What native mode gives up

- **Depth against the 3D scene.** Quads are not depth-tested. A quad is drawn whole, in front of
  or behind another by distance; VRChat depth occlusion (`vrchatDepth`) does not apply to UI
  shown this way.
- **Depth for the pointer.** Laser beams and cursor dots are drawn over everything PetPlay
  shows; in the panorama UI in front of a beam covered it.
- **Edit layout chrome** (snap slot markers) is still in the panorama and keeps its lag.

## Measured against SteamVR

`deno run -A --no-check tests/native_overlays/steamvr_probe.ts` runs the production path against a
running SteamVR with the test scene 40 m below the floor, and compares the picture SteamVR holds
for every quad with the one drawn for it, through panels coming and going, new sizes, a panel
resized while shown, the eye targets rebuilt and a slot SteamVR knows at another size. On SteamVR
2.18.4 (Windows, Quest Pro through the Oculus driver, 2026-11-26):

- GL render-target textures are accepted as they are (`TextureType_OpenGL`, default bounds).
  `SetOverlayTexture` takes the texture's content of that moment; two textures alternate per quad
  so the one being drawn is never the one last handed over.
- A panel anchored to the head came out attached to the HMD at the right place and was **placed
  once** over 60 frames of a worn, moving headset: the place on the device derived from two
  tracked poses each frame stays within the 20 µm threshold.
- A box outline was placed once and drawn once while the eyes stood still, not drawn again for
  2 mm of eye travel, and once more for 30 mm.
- A 1.07 m laser beam came out on a quad as long as itself and centred on it, drawn once, with a
  4096 x 16 texture at a texel aspect of 0.52 and sort order 2; its dot on a 15 mm quad at sort
  order 3; a beam riding the headset was attached to it. SteamVR held the right picture for each.
- A hidden quad keeps its picture: shown again, it needs no new texture.

What could **not** be measured is how SteamVR sizes a side-by-side quad: from one eye's half of
the texture, or from all of it (then half as tall, to be corrected with a texel aspect of 0.5).
OpenVR does not document it. `ComputeOverlayIntersection` is no help (it follows the overlay's
mouse scale and reports a square for every quad left at the default, whatever is drawn), and
`IVRCompositor::GetMirrorTextureGL` fails for an overlay application here. So it is a setting,
`nativeStereoSizing` (`halved` by default, Settings → Debug → Stereo Quad Shape A/B), to be judged
in the headset: with the wrong choice the teal cube and the window outlines are half or twice as
tall as they should be. Judged that way on this setup, `halved` is right.

`tests/native_overlays/render.ts` checks the pictures themselves offscreen, without SteamVR, and
`deno task playtest native-overlays` the scene side through the real React tree.

In the headset (same setup): the Settings window as a quad holds still under head movement and
reads sharper than in the panorama. Since the texture-size fix the teal test cube and the window
outlines look right too, with `nativeStereoSizing` at `halved`, and so do the laser beam and its
dot on their quads (2026-11-27). To see what SteamVR holds for a running PetPlay's quads
without a headset: `deno run -A --no-check tests/native_overlays/steamvr_dump.ts`.

## Knobs

Live, in the renderer (`SETRENDERERDEBUG`): `nativeTexelsPerPixel` (0.5–4), `nativeStereoEyeSize`
(64–2048), `nativeStereoSizing` (`halved` or `full`, also the setting of that name),
`nativeStereoTexelAspect` (a number stands in for what the sizing says, `null` leaves it to that).
`SETNATIVEPANELS` switches panels on and off without the setting. Health (`state.native`,
`state.nativeError`) reports quad counts, redraws, spare overlays, size mismatches and each
quad's state (pictures, placements, device, hidden).

## Code

| File | Role |
| --- | --- |
| `classes/nativeOverlayContent.ts` | snapshot types, the stereo and opt-out `userData` |
| `classes/webxrRaythreeUi.ts` | describes each root during UI extraction |
| `classes/overlayRenderTracking.ts` | lowers `nativeStereo` onto instances; re-poses panel planes |
| `classes/nativeOverlayMath.ts` | the split, panel camera, attachment, stereo quads and cameras, the pointer's quads, texture size steps, content hashes |
| `classes/webxrOverlayRaylib.ts` | `renderNativePanel`, `renderNativeStereo`, `renderNativeMesh`, their textures (pooled by size) |
| `classes/webxrRaythreeRaylibRenderer.ts` | `renderUiOnly`, `renderInstancesOnly` |
| `classes/openVrNativeOverlays.ts` | the SteamVR quads, one texture size per overlay |
| `classes/nativeOverlayLayer.ts` | one frame of all of the above |
| `petplay/overlayRenderOwner.ts` | calls it after the eye image, with the tracked devices |
| `classes/environment/grabbox.tsx` | marks the outline's bars |
| `classes/environment/petplayXrController.tsx` | marks the laser beams and the cursor dot |
| `classes/environment/debugTestCube.tsx` | the test cubes |
| `tests/native_overlays/steamvr_probe.ts` | the production path against a live SteamVR, pictures compared |
| `tests/native_overlays/steamvr_handle_probe.ts`, `steamvr_texture_probe.ts` | what SteamVR does with texture sizes, slots and texture numbers |
| `tests/native_overlays/steamvr_dump.ts` | saves the picture SteamVR holds for each native quad of a running PetPlay |
