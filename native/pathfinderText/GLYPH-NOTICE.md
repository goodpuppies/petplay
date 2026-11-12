# Glyph Slug adapter provenance

Pinned upstream: pmndrs/glyph `4e25a96a57462fef5ad0d19065a822695b480f60`, MIT.
See GLYPH-LICENSE. Cargo.lock pins the actual curve/band generator and packer dependency.

`src/glyph.rs` adapts font-kit outlines to `pmndrs-glyph-slug-core`. It uses upstream's line/cubic
normalization, half-float quantization, band builder and V0 packer. Its preparation follows
`packages/glyph/rust/slug-baker/src/artifact.rs`, retaining 16 bands and 2048 plane units per em.
Font preparation happens once on native renderer initialization. This initial adapter consumes
the existing fonts/BMFont character sets rather than loading `.font.glb` or adopting Glyph layout.

`src/glyph.vert` and `src/glyph.frag` adapt the mathematics and control flow in:

- `packages/glyph/src/shaders/tsl/slug/slug-dilate.ts`
- `packages/glyph/src/shaders/tsl/slug/slug-render.ts`
- `packages/glyph/src/shaders/tsl/slug/slug-band.ts`
- `packages/glyph/src/shaders/tsl/slug/solve-quadratic.ts`
- `packages/glyph/src/shaders/tsl/slug/calc-root-code.ts`
- `packages/glyph/src/shaders/tsl/slug/calc-coverage.ts`

Upstream attributes the shader mathematics to three-flatland Slug at `2935a89f` (MIT), with
the stable-root solver adapted at `866f77f9`. Those headers are retained as provenance here.
The first port implements the nonzero-winding baseline without optical weight boost, thickening
or stem darkening. It keeps the em-space curves and perspective-correct interpolated coordinates.

Storage is uploaded directly as V0 RGBA16F curves, R32UI headers and R16UI references. Unlike
the Three TSL route, this GLSL330 path can fetch R16UI directly, so no reference-pair repacking
is needed. Bounds and band transforms use the same quantized plane bounds as the packer.

The adapter repairs a pinned packer row-boundary case: when two consecutive curves in a contour
are separated by a skipped last-column texel, the prior curve reads that skipped texel as its
shared endpoint. The packer leaves it zero. The adapter fills only proven continuation gaps with
the next curve's start position; addresses, headers and references stay unchanged. An independent
CPU curve evaluator in `tests/pathfinder_text/headless.py --glyph` checks GPU `@` and `s` coverage.
Before the workaround `s` differed by up to 255/255; afterward both match at the tested phases.
The upstream reference checkout is unmodified.

Glyph quads are instanced in contiguous font-page runs, preserving order; no per-character
native FFI calls or render-target submissions occur. The GLSL output uses straight RGB with
coverage alpha to match PetPlay's UI blending, rather than blending premultiplied coverage twice.

This is an experimental native adapter, not the complete Glyph Three renderer. Its limitations
include a fixed bundled font subset, preparation on initialization, per-eye instance uploads,
and the current UI pass's existing lack of text clip planes. Font shaping, arbitrary font loading,
color fonts and `.font.glb` interchange are not implemented by this slice.
