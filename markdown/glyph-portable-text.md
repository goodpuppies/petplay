# Portable Glyph text (no native library)

Goal: ship Glyph (Slug) vector text in releases on every platform, without
`resources/libpetplay_pathfinder_text.so`. Releases hide VECTOR (Pathfinder) and WIND (Windfoil);
see `experimentalTextRenderersShown` in `classes/textRenderingSettings.ts`.

## Why this works

`@pmndrs/glyph` is a web typography engine. Its `glyph bake` CLI writes `.font.glb` files with the
Slug data that our native code builds at startup today. Both come from the same `slug-core` packer
(our Cargo.toml pins commit `4e25a96a`). The baked data therefore matches, except the pages are 4096
texels wide instead of 1024. Our shader port (`native/pathfinderText/src/glyph.frag`) reads widths
with `textureSize`, so either width works.

## Bake

Use the npm canary built from the pinned commit, so the data matches the Rust crate:

```bash
cd _scratch/glyph-bake
npm install --legacy-peer-deps @pmndrs/glyph@0.1.0-canary-4e25a96a-20261015
F=../../resources/fonts
npx glyph bake --input $F/roboto/Roboto-Regular.ttf --output roboto.font.glb \
  --unicodes "$(cat ../../utils/glyph-bake/roboto.set)" --slug --outlines --yes
npx glyph bake --input $F/material-icons/MaterialIcons-Regular.ttf --output icons.font.glb \
  --unicodes "$(cat ../../utils/glyph-bake/icons.set)" --slug --outlines --yes
```

The Unicode sets are the characters of the two BMFont files that the UI lays text out with:

- `utils/glyph-bake/roboto.set`: every code point below U+E000 in either `.fnt`. This includes the
  Latin-1 extras from `material-icons.fnt`, which the native code draws from Roboto.
- `utils/glyph-bake/icons.set`: the code points from U+E000 up.

That comes to 190 Roboto characters (245 KB) and 48 icons (65 KB). `--outlines` keeps outlines for a
later Windfoil port. Drop it if Windfoil never ships.

## Format (`PMNDRS_font_slug` version 0)

- **Text to glyph ID:** the `cmap` of the subset sfnt in `PMNDRS_font.shaping.bufferView`. Glyph IDs
  are renumbered: Roboto's 190 characters became 203 glyphs.
- **Records:** `recordBufferView` holds 40 bytes per glyph ID, in the order of `SlugGlyphRecord`.
  - Plane bounds left/bottom/right/top: i16, in 1/2048 em.
  - `page`, horizontal band count, vertical band count, `flags`: u16 each.
  - Curve base texel, curve span texels: u32 each.
  - Horizontal header base, vertical header base: u32 each.
  - Curve reference base, curve reference count: u32 each.
  - An absent glyph has `page` 0xFFFF and every other byte 0.
- **Curves:** RGBA16F in an uncompressed KTX2 container (supercompression 0). Read the bytes from
  the level index at offset 80. Each curve is one texel holding its start and control points; each
  contour ends with one texel holding its last end point. The last texel of each row is skipped.
- **Headers:** R32UI, raw bytes, `headerWidth` × `headerHeight`.
- **References:** R16UI, raw bytes, `referenceWidth` × `referenceHeight`.

`utils/glyph-bake/check_slug.py` decodes `@ s A g é €` and three icons from the baked files. It
checks them against the source fonts with fontTools: every on-curve point and the bounds match
within f16 precision (checked 2026-11-12).

## As built (2026-11-12)

- **Fonts:** `resources/fonts/glyph/{roboto,icons}.font.glb`. The build already embeds `resources/`.
- **Loader:** `classes/glyphFont.ts` parses the glTF, reads the cmap and records, and returns the
  three textures per page. It also fills the pinned packer's continuation gaps, which the native
  loader patched too. The baked file does not record contours, so `check_slug.py` asserts that no
  gapped glyph can close a contour at (0, 0).
- **GL:** `classes/glFunctions.ts` reads raylib's `glad_gl*` pointers, which every shipped raylib
  exports (Linux x86-64 and ARM64, Windows). A Deno `pointer` static is the variable's _address_:
  dereference it. Calling the address segfaults.
- **Renderer:** `classes/glyphText.ts` builds the same instances as the native `pp_glyph_draw` and
  draws them with the same shaders (`classes/glyphShaders.ts`, copied from
  `native/pathfinderText/src`). It saves and restores the GL state it touches.
- **Check:** `tests/pathfinder_text/render.ts` now runs Glyph through the TypeScript renderer.
  Against the native renderer's output, at most 12 of about 4,300 lit pixels differ, by 1/255. That
  holds for every tuning variant.
- **Available everywhere:** Glyph is available on every platform, whenever the baked fonts are
  present. Vector and Windfoil still need the native library and are hidden in release builds.

## Next

- Drop Glyph from the native library. Windfoil still uses its shared setup, so do it when Windfoil
  is ported or retired.
- Port Windfoil the same way, using the baked `--outlines`.
- Pin the npm version next to the Cargo pin: `.font.glb` is versioned (0.x) and may change.
