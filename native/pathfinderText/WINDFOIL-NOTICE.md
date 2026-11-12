# Windfoil comparison backend

Modified GLSL330 implementation of the closed-form box-filtered winding integral
in Rune `7dfaa8fb1fa8281e6e2ccc92568d95262e9c6f3c`, `crates/rune/src/outline.wgsl`,
and xy-monotone splitting from `text/outline/build.rs`. Rune is MIT licensed;
see WINDFOIL-RUNE-LICENSE. Those files attribute the integrals and splitting to
texel-org/windfoil-algorithm (Apache-2.0); see WINDFOIL-APACHE-LICENSE and
https://github.com/texel-org/windfoil-algorithm/blob/main/docs/ALGORITHM.md.

`src/windfoil.frag` ports the integral and stable monotone roots, with PetPlay's
existing coverage exponent, coverage dilation and AA-width experiments applied
after/before integration. `src/windfoil.rs` prepares xy-monotone pieces once.
Unlike the Slug backend, these are full-float curves and exact straight lines.

This comparison shares Glyph's instancing, bundled fonts, BMFont placements and
perspective interpolation. It does not port Rune's full text system, hinting,
CoreGraphics outline dilation, caching, or luminance-dependent coverage tuning.
It gathers every piece of each glyph, without Rune's row-band acceleration.
The local axis-aligned derivative footprint approximates a perspective pixel;
it is not exact integration over a projectively transformed pixel polygon.
