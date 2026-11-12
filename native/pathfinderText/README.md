# Experimental native text renderers

This native pass draws vector font outlines into the framebuffer already owned by PetPlay's
raythree/Raylib UI renderer. It keeps the stereo panorama and the existing UI root ordering.
It does not own a window, compositor layer or GL context.

Build on Linux with Cargo, the OpenGL development library, and font-kit's native font dependencies
(FreeType, fontconfig and expat):

```bash
deno task text:pathfinder:build
PETPLAY_TEXT_RENDERER=pathfinder deno task server
```

The same library now also includes **pmndrs/glyph's Slug backend**. Use `deno task text:build`
(the old build task remains an alias), then `PETPLAY_TEXT_RENDERER=glyph deno task server`, or
select GLYPH from wrist Settings → TEXT. MSDF, VECTOR (Pathfinder) and GLYPH can be compared
without changing the text layout or panorama. The default remains MSDF.

Glyph's pinned Rust curve/band generator and packer are used directly. A native font-kit adapter
prepares the existing font subsets once at initialization, and an instanced GLSL330 port evaluates
the curves with perspective-aware quad dilation. The initial baseline disables optical weight
boost and stem darkening. Details and source attribution are in [GLYPH-NOTICE.md](GLYPH-NOTICE.md).
It requires Rust 1.97.1 or newer due to the upstream dependency. This slice does not load `.font.glb`
assets, use the Glyph Three renderer, or change shaping/layout.

Alternatively append `--text-renderer=pathfinder` to the server command. The process entry forwards
that selection to child render workers through `PETPLAY_TEXT_RENDERER`. The default remains
`msdf`. A missing library produces a build instruction; groups from unsupported/older geometry
without vector placements fall back to MSDF with a warning.

In VR, open wrist Settings → TEXT for live comparison. MSDF/VECTOR changes glyph rendering;
LINEAR/SHARP changes panorama reconstruction. The @ samples on dark and light panels stay in
place during changes. Choices apply to the scene without reload and are saved in user settings;
unset choices follow the session environment. Render selections travel in the UI snapshot to
each render consumer, rather than relying on shared module state across processes.

Pathfinder is pinned in Cargo.toml/Cargo.lock. Build output and Cargo caches go under `_scratch/`;
the final shared library is copied atomically into `resources/`. No dependency checkout is modified.
The library embeds Roboto Regular and the existing Material Icons font. Their outlines use the
pen positions, font em size and baselines extracted from the existing BMFont geometry. No string
reshaping or reflow is performed. The mixed Material Icons atlas's Latin-1 additions retain their
Roboto baseline override. Roboto's exact version may differ from the old atlas's source font.

The ABI accepts packed glyph records and projects/clips outlines for each current eye. All labels
in one existing UI root text group go into one Pathfinder scene, even when their planes differ.
Unhinted font outlines are cached across frames. The first version builds projected paths each
draw using the GL3 raster backend and sequential CPU executor. It has not been optimized for a
full keyboard in motion; real scene frame cost and headset quality remain to be measured.

The renderer flushes rlgl before native calls. A native guard preserves the framebuffer, viewport,
shader, VAO/buffers, textures and relevant render state across create/draw/destroy. It currently
requires a zero-origin viewport and Linux desktop OpenGL. It uses upstream's current (deprecated)
outline perspective/clipping API. LCD subpixel AA and dilation are disabled. Compositing follows
the existing UI's encoded framebuffer color space; gamma/coverage tuning remains comparison work.

The existing UI text pass does not carry text clip planes. This implementation preserves that
behavior; adding scroll clipping to both text backends is separate work.

Checks:

```bash
python3 tests/pathfinder_text/headless.py
python3 tests/pathfinder_text/headless.py --glyph
deno run -A --no-check tests/pathfinder_text/render.ts
deno test -A --no-check classes/vectorTextGlyphs.test.ts classes/uiTextSnapshotCache.test.ts classes/overlaySceneWire.test.ts
deno task check
```

The Python test uses surfaceless EGL without a display. The Deno test creates a hidden Raylib GL
window and exports only offscreen test targets under `_scratch/`; it requires a display server.
It runs real MSDF geometry through the UI extractor and all three production rendering paths, checks
label counts over repeated frames, and issues a host draw after the native pass.

The Glyph Python check additionally uses `fontTools` to read the font independently and evaluates
coverage on the CPU for `@` and `s`, checking the GPU's curve packing/band addressing and GLSL port.

The `--no-check` test commands avoid unrelated vendor type errors; `deno task check` is the
repository's filtered application type check.
