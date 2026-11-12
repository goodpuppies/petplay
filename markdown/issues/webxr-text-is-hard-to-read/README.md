# PetPlay's rendered UI text is hard to read in VR

Status: in progress — opt-in Pathfinder text pass integrated 2026-11-08
Track: Basic UI/UX

## What happens

PetPlay's menus and keyboard legends are hard to read. Captured desktop text is readable.
The existing MSDF implementation is taken as technically correct; the requested work is a
higher-quality text rendering method. Text size and UI layout changes are outside this issue.

## Direction

Start with Pathfinder directly, using its vector coverage rasterizer as the implementation
and reference before deciding whether a smaller reimplementation is justified. Keep the
existing stereo panorama and raythree render pipeline. Text is spread throughout the scene;
separate synchronized compositor layers would add unnecessary complexity for this work.

Pathfinder integration belongs on the rendering side of the raythree path. OpenVR is only a
presentation backend; glyph rendering must also work for desktop/headless consumers. The current
UI extension and production Raylib renderer live in PetPlay, rather than raythree's core IR:

- `classes/webxrRaythreeScene.ts`: extracts raythree geometry and the UI snapshot.
- `classes/webxrRaythreeUi.ts`: UI text, panels, images, ordering, transforms and anchors.
- `classes/overlaySceneWire.ts`: cached glyph geometry delivery to the independent renderer.
- `classes/webxrRaythreeRaylibRenderer.ts`: ordered UI rendering and the current MSDF text pass.
- `classes/webxrOverlayRaylib.ts`: eye targets and stereo panorama combine.

## Feasibility evidence, 2026-11-08

An isolated Rust probe builds upstream Pathfinder at
`6c3c0466f451c5bd2007087728cd168798cd64e8` without modifying upstream. It creates an EGL
surfaceless OpenGL 3.3 context, loads a supplied font file, and draws text directly into a
caller-owned RGBA8 framebuffer. Both ordinary and perspective builds rendered successfully, with LCD subpixel AA
disabled (the default). The exported images were inspected; both contain fractional edge values
and visible glyphs, including äöå.

The sandbox selected llvmpipe software rendering. This establishes build/render feasibility,
not GPU performance or an improvement over PetPlay's existing text. No same-font MSDF comparison,
stereo panorama comparison, real GPU benchmark or headset validation has been done yet.

Pathfinder's GL device permits selecting an existing framebuffer; the prototype creates its own
offscreen target in an EGL context, not PetPlay's eye targets. Its perspective
`BuildOptions` take one global transform per scene. Independently positioned text therefore
needs a deliberate grouping/projection strategy; one build per label could be expensive.

## Reproduce the isolated probe

From the repository root, with Rust, EGL/OpenGL development libraries and the font-kit native
dependencies available:

```bash
bash markdown/issues/webxr-text-is-hard-to-read/run-probe.sh /absolute/path/to/Roboto-Regular.ttf
```

The runner downloads the pinned reference checkout if absent, builds in `_scratch/`, and exports
`front.ppm` and `tilted.ppm` there. It does not start PetPlay, SteamVR or a desktop window. The
font is an explicit argument; no system font selection or unrelated repository is required.
`probe.rs`, `probe.Cargo.toml` and `probe.Cargo.lock` preserve the tested source and dependency
resolution. Outputs and build caches remain under `_scratch/pathfinder-spike/` and
`_scratch/pathfinder-cargo/`.

## Initial integration, 2026-11-08

The production raythree/Raylib UI pass now supports `PETPLAY_TEXT_RENDERER=pathfinder` or
`--text-renderer=pathfinder` (default: MSDF). Build with `deno task text:pathfinder:build`.
See [the native renderer instructions](../../../native/pathfinderText/README.md).

Glyph placements are extracted from the existing MSDF geometry's visible glyphs, with the same
kerning, line positions, baselines and em size. They travel in the existing cached geometry asset,
including transport byte accounting and interning. No second text layout engine is used.

The Rust library caches unhinted font outlines, clips/projects them for the current eye and
submits one Pathfinder scene per existing root text group. A native state guard and rlgl flush
permit interleaving with the host's draws. It draws into the current eye framebuffer, retaining
the existing panorama. No OpenVR-specific text path or compositor layer was added.

The native EGL check passed for caller-owned framebuffers, fractional coverage, independently
transformed glyphs, icons/Latin text, background preservation and checked GL state across
create/draw/destroy. An offscreen A/B through the production extractor and renderer also passed
on an AMD RX 7900 XTX, producing both MSDF and Pathfinder exports under `_scratch/`. That test
checks real glyph geometry, repeated frames and host overdraw after the text pass. Placement,
transport and cache regression tests pass as well.

This is an experimental Linux OpenGL backend. The bundled Roboto font may differ in version from
the old atlas's source, so the initial A/B does not establish exact outline equivalence. The
full scene's CPU/GPU cost, panorama output, headset quality and temporal stability still need
comparison. The default remains MSDF; this issue is not marked fixed.

## First headset feedback, 2026-11-08

After switching the running session through the REPL and reloading `webxr`, the user reported an
immediate improvement in readability, with edges still slightly blurry/soft. Live inspection
confirmed Pathfinder was drawing glyphs without the MSDF fallback, with the stereo panorama
active. The eye targets were 2980×2980 and the stacked panorama target 5960×5960.

Two stages need separate comparison: raw Pathfinder coverage (currently unhinted, without stem
darkening or the text gamma filter), and eye-to-panorama resampling (currently bilinear). The
compositor samples that panorama afterward. Bilinear reconstruction is a plausible source of
additional softness, but has not been isolated as the cause. Compare eye and presented output
before choosing between a sharper reconstruction filter and text coverage/stem tuning. Keep
text placement, UI dimensions and the panorama architecture fixed during these comparisons.

## Integration follow-up

### Glyph Slug integration, 2026-11-09

Added a third backend, `glyph`, using pmndrs/glyph at
`4e25a96a57462fef5ad0d19065a822695b480f60`. The native adapter depends directly on Glyph's Rust
curve/band generator and V0 packer; a GLSL330 port follows its stable-root coverage and per-edge
perspective dilation. The existing font subsets are prepared at initialization. Existing BMFont
pen positions/baselines, UI ordering and the stereo panorama remain in place. There is no new
Three renderer, layout/shaping pass or synchronized compositor layer.

The first version uploads static curve/header/reference textures and instances glyph quads in
contiguous font-page runs. MSDF, VECTOR (Pathfinder) and GLYPH are selectable on the comparison
page. Initialization and per-eye instance upload costs, full-scene performance and in-headset
preference still need measurement. The baseline uses no optical weight boost/stem darkening.
This is a native Glyph-core adapter rather than support for the whole `.font.glb` asset pipeline.

Build: `deno task text:build`. See `native/pathfinderText/GLYPH-NOTICE.md` for exact provenance
and storage conventions. The surfaceless native GL state/background/glyph test passes for Glyph;
offscreen production tests cover repeated switching between all three backends, mixed fonts,
oblique text and host overdraw. The isolated controller test exercises the GLYPH menu choice.

Visual QA caught missing arcs in `s`. The pinned Glyph packer can leave a zero texel between
consecutive curve records at a row boundary; the preceding curve still reads it as its shared
endpoint. The native adapter fills those continuation gaps. A separate fontTools outline reader
and CPU ray evaluator now compare the GPU result for `@` and `s`; both match exactly at the
tested 32-pixel-em sampling phase after the workaround. The earlier `s` result differed by up to
255/255, so this check catches actual geometry loss rather than just renderer availability.

Hot-reloaded the GLYPH option into the live session after validation. The REPL confirmed
`glyphAvailable: true`, active Pathfinder + Catmull-Rom unchanged, frames advancing and no error.
The user can choose GLYPH on the TEXT page; no headset quality/performance conclusion yet.

### Distance investigation, 2026-11-09

The user reports that a small, close keyboard is clearer than a larger, farther keyboard, including
with VECTOR + SHARP and while stationary. Treat projected size and shape as controlled variables;
this is not a request to enlarge the UI.

`tests/pathfinder_text/distance.ts` exercises the production extractor, Pathfinder eye renderer
and sharp panorama combine on offscreen targets. It renders the same `@` at 0.25, 0.5, 1, 2 and
4 metres, scaling displacement and glyph dimensions together. Eight projection cases cover two
pixel heights, two orientations and two viewport positions. It writes pixel differences and
reference/candidate images under `_scratch/text-distance/`.

The 40 renders give 32 comparisons against each case's nearest reference: 22 were bit-identical
in both the eye and panorama; eight differed by at most one 8-bit channel level; two angled
cases changed six eye-edge pixels (up to 53 levels, with panorama differences up to 26 levels).
Those two occurred at 0.5 and 2 metres, while 1 and 4 metres matched or nearly matched the near
reference. This does not reproduce broad, monotonically distance-dependent blur. Small numerical
edge sensitivity remains and must not be described as exact invariance.

Live metadata confirms keyboard and wrist `@` use Roboto and the same white color. A captured
pose was not an exact match in projected shape: keyboard ~9.4×11.0 eye pixels versus the largest
wrist sample ~9.2×17.3. Measurements use `host.captureShadowFrame()` matrices, the actual render
input, rather than scene camera objects that may have changed after pose capture. This snapshot
does not establish the cause of the user's matched-size observation.

The in-VR TEXT page now has an optional Depth probe: OFF / NEAR / FAR. It shows a single
head-facing `@` at 0.35 or 1.40 metres, scaling size and displacement together to preserve its
cyclopean projection. It uses the existing text backend and panorama. Stereo disparity and
individual-eye pixel phases necessarily change. The probe starts off and is hidden when leaving
the page. The isolated controller test verifies near/far transforms and cleanup, and passed.

The remaining investigation is whether the controlled in-headset comparison reproduces the
effect, including whether it survives viewing with one eye. Stereo composition, output sampling
and the headset view remain outside the isolated offscreen distance result; no physical/optical
cause has been established.

### Panorama reconstruction A/B, 2026-11-08

The GLSL330 panorama combine now has a live filter switch: `linear` (the existing default) or
`catmull-rom`. The cubic variant combines its positive middle taps using hardware bilinear
sampling, for nine texture fetches. Its outer taps are clamped at eye boundaries. It reconstructs
the same eye image; glyph coverage, placement, eye resolution and panorama geometry stay fixed.

`tests/pathfinder_text/panorama.ts` compiles the production shader and checks the reconstruction
function on a GPU against a CPU reference over subpixel phases. Both modes passed with less
than one 8-bit level of error. The repository type-check passed as well.

The current session was reloaded with Pathfinder and `PETPLAY_PANORAMA_FILTER=catmull-rom` for
headset comparison. The class exposes `setPanoramaFilter("linear" | "catmull-rom")` on the GL
owner; through the WebXR REPL this is `state.raylibOverlayRaylib.setPanoramaFilter(...)`, so
further toggles need no reload. The environment variable supplies the initial selection on reload.
With the comparison UI below, change `panoramaFilter` through the settings store (or that UI);
the incoming IR selection takes precedence over a direct renderer-only setter call.
Headset preference, ringing/halos, motion stability and frame cost remain to be assessed.

### In-VR comparison controls, 2026-11-08

The user reported that performance was acceptable and cubic reconstruction looked better, while
some blur remained, especially on `@`. Wrist Settings → TEXT now exposes independent MSDF/VECTOR
and LINEAR/SHARP choices, plus fixed `@`, counters and stroke samples on dark and light panels.
Selections apply immediately and persist through the settings store. They travel in the UI IR
and its fingerprint so independent consumers receive changes even with otherwise static content.
The native outline cache stays alive during switches back to MSDF.

An isolated no-VR controller playtest opens the page, switches each option, checks the source IR,
verifies that the sample mesh and its world matrix stay fixed, and navigates back. It passed.
Repeated MSDF → Pathfinder → MSDF → Pathfinder changes on one production renderer also passed
the offscreen GL integration check. These controls prepare the next coverage/glyph comparison;
they do not change the font outlines or add stem darkening.

1. Establish the original atlas font provenance for an exact same-outline comparison. Existing
   placements are preserved, but the bundled outline font's version may differ. Extend the
   optional glyph placement asset into a generic vector asset contract if other producers need it.
2. Exercise full menus and keyboards through actor transport, hot reload and real tracked anchors.
   Verify panel/text/image ordering with overlapping roots and light/dark panels. Text clip planes
   are absent from the current pass; scroll clipping needs an explicit contract for both backends.
3. Reuse more projected/build state where measurements justify it. Cached font outlines already
   survive frames, while per-eye projected paths are rebuilt. Keep rasterizing coverage at the
   current eye projection rather than inserting a fixed-resolution text bitmap.
4. Compare current MSDF and Pathfinder through the unchanged eye/panorama presentation, holding
   fonts, placement, dimensions and poses fixed. Include angled text, thin strokes, small counters,
   slow head/controller motion and several UI roots. Evaluate static edges and temporal stability.
5. Measure build, draw and state-transition costs on the GPU, especially many independent labels.
   Validate alpha/gamma compositing over light and dark panels and resource lifetime across reload.

Only after that comparison choose the production default or investigate a focused reimplementation.
The original feasibility probe remains reproducible separately; the initial production integration
above is available only when explicitly selected.

### Glyph coverage and weight comparison, 2026-11-12

Rune's text renderer suggested separating the coverage curve from optical weight. The
GLYPH backend now exposes two independent settings in Wrist Settings → TEXT:
`glyphCoverageExponent` (1.00 / 0.85 / 0.70) and `glyphWeightPixels` (0 / 0.125 / 0.25).
Defaults remain 1 and 0. These values travel with the text-rendering IR and participate
in scene fingerprints. Other text backends ignore them.

The exponent shapes fractional coverage; it is not a correction of framebuffer color
space. The weight option takes the maximum of the original coverage and four eye-pixel
offset evaluations, using screen derivatives of the perspective-interpolated glyph
coordinate. This is an experimental cross-shaped dilation of coverage, not Rune's
centered outline dilation or a Windfoil port. Outlines, layout advances and font size
are unchanged. Weight zero avoids the four extra coverage evaluations.

The additive `pp_glyph_draw_tuned` entry point validates finite, bounded parameters;
legacy `pp_glyph_draw` retains its original defaults and ABI. Older native libraries
still support the baseline; trying nondefault tuning without the new entry point fails
explicitly instead of silently ignoring the selection.

Validation: native headless checks preserve exact legacy/default pixels and GL state,
exercise both polarities at 16/32 ppem under flat and perspective transforms, and reject
invalid tuning. The production UI renderer verifies independent effects and exact reset
across backend changes. The isolated no-VR controller playtest checks settings entering
the IR and unchanged sample geometry/placement. GPU readbacks were inspected locally.

A paired 10-glyph, 32-pixel offscreen microbenchmark on the RX 7900 XTX measured median
submit-plus-finish time of 0.0311 ms/draw with weight zero and 0.0430 ms/draw at 0.125,
both at exponent 0.85. This is not full-scene GPU timing or headset performance evidence.
Headset sharpness, acceptable weight, counters, halos and motion stability remain to be
compared. Start with exponent 0.85 and weight zero; vary weight independently.

### Glyph AA footprint comparison, 2026-11-12

The user prefers coverage 0.70 / weight 0.125 on the current headset, but still
reports soft letter edges. Added an independent `glyphAaWidth` setting (100%,
85%, 70%) to Wrist Settings → TEXT. It scales the Slug coverage footprint before
ray integration. Glyph coordinates and actual eye-pixel weight offsets are
unchanged. Width 1 is the original behavior and remains the default.

The additive `pp_glyph_draw_filtered` entry point accepts the new parameter;
legacy/default entry points retain width 1. Unsupported nondefault settings
fail explicitly against an older native library. Scene transport and fingerprint
checks include width changes.

The independent CPU curve reference matches GPU `@` and `s` coverage at four
horizontal pixel phases for all three widths, within three 8-bit levels. Across
these samples, partial-edge pixel counts fall from 1145 (100%) to 942 (85%) and
779 (70%). This establishes a narrower transition at unchanged outline positions,
not improved headset quality. Production renderer checks preserve exact reset;
the isolated controller playtest preserves sample placement. Type-check passes.

The live comparison starts at AA width 85%, retaining coverage 0.70, weight 0.125,
SHARP filtering and 3560-pixel eyes. Stationary clarity and shimmer during slow
head/controller movement still need in-headset comparison.

### AA width has no visible headset effect, 2026-11-12

The user reports no visible change from the AA-width control. A one-shot live
probe confirmed a nonempty Glyph group consumes width 0.70, coverage 0.70 and
weight 0.125 successfully; no missing-layout MSDF fallback was flagged.

Captured one application's render payload at frame 6434 and replayed it offscreen
at identical poses and 3560-pixel eye targets. With coverage/weight fixed, width
1 → 0.70 changes 23,128 left-eye pixels (maximum RGB delta 87/255), and the effect
survives in the panorama (63,025 pixels, maximum delta 81/255). Resetting width to
1 reproduces both initial textures exactly. Thus the control is connected and
the panorama does not erase its effect entirely. Inspected crops show localized
edge differences, not a broad improvement to readability. This does not locate
the perceived headset blur or establish a Steam Link/compositor cause.

Diagnostic payload, readbacks and comparison script are under `_scratch/`;
the live selection was left unchanged. Treat AA width as ineffective for the
reported perceptual problem rather than claiming the pixel test proves a fix.

### Windfoil coverage backend comparison, 2026-11-12

Added a `windfoil` renderer selection (WIND on the TEXT page). It ports Rune's
closed-form box-filtered winding integral and xy-monotone preparation into the
existing native Glyph instancing/placement path. Font outlines, BMFont advances,
font size, UI placement, eye targets and stereo panorama remain shared. Coverage,
weight and AA-width controls apply to both GLYPH and WIND, without resetting them
on a switch. GLYPH remains the existing implementation.

See `native/pathfinderText/WINDFOIL-NOTICE.md` for exact provenance, bundled licenses
and limitations. This is the coverage algorithm, not Rune's full renderer: no Rune
hinting, CoreGraphics outline dilation, atlas cache or luminance-specific gamma.
Curves are full-float and lines exact; an axis-aligned derivative footprint is an
approximation under perspective. The first comparison gathers every glyph piece
without Rune's row bands, so complex glyphs still need performance scrutiny.

Validation: Windfoil GPU pixels for `@`, `s`, `g`, `I` at 16/32 ppem agree with an
independent numerical integration of original font outlines (1024 y slices/pixel),
with maximum error 0/255 in the sampled cases. Native create/draw/destroy preserves
GL state; production integration covers mixed fonts, oblique text, native/host
overdraw, control effects and exact resets through backend switches. The isolated
controller playtest reaches WIND and preserves sample geometry. Settings/transport
tests and type-check pass.

Replaying the captured frame with coverage 0.70, weight 0.125, AA width 70%, SHARP,
and 3560-pixel eyes changes 13,976 left-eye pixels (max RGB delta 62/255) and 38,478
panorama pixels (max 58/255) versus Glyph. Returning to Glyph restores both initial
textures exactly. Inspected eye crops show localized edge differences; this does
not establish a meaningful headset sharpness improvement.

Four alternating offscreen submit+GPU-finish samples on the shared RX 7900 XTX were
5.12–6.92 ms/frame for Glyph and 3.87–4.63 for Windfoil. This is a small, busy-GPU
replay check, not a claim of faster headset rendering. Full-scene head motion and
in-headset readability remain to be compared. Artifacts are in
`_scratch/windfoil-comparison/`.

## Upstream references

- [Pathfinder](https://github.com/servo/pathfinder): vector coverage AA, font dilation and GL backend.
- [GL framebuffer selection](https://github.com/servo/pathfinder/blob/6c3c0466f451c5bd2007087728cd168798cd64e8/gl/src/lib.rs).
- [Perspective build options](https://github.com/servo/pathfinder/blob/6c3c0466f451c5bd2007087728cd168798cd64e8/renderer/src/options.rs).
