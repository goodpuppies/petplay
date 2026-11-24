import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { parseGlyphFont } from "./glyphFont.ts";

const load = (name: string) =>
  parseGlyphFont(Deno.readFileSync(new URL(`../resources/fonts/glyph/${name}`, import.meta.url)));

Deno.test("the baked Roboto has Slug data for every UI character", () => {
  const roboto = load("roboto.font.glb");
  assertEquals(roboto.pages.length, 1);
  assertEquals(roboto.pages[0]!.curves.width, 4096);
  // 190 code points, less the space, which has no outline.
  assertEquals(roboto.glyphs.size, 189);
  assertEquals(roboto.gapsFilled, 1, "the one packer gap in this bake");
  const at = roboto.glyphs.get("@".codePointAt(0)!)!;
  // Same bounds utils/glyph-bake/check_slug.py decodes and fontTools reports.
  [0.055, -0.221, 0.848, 0.699].forEach((v, i) => assertAlmostEquals(at.bounds[i]!, v, 1e-3));
  assert(at.horizontalBands > 0 && at.verticalBands > 0);
});

Deno.test("the baked icons map their private-use code points", () => {
  const icons = load("icons.font.glb");
  assertEquals(icons.glyphs.size, 48);
  assertEquals(icons.gapsFilled, 0);
  const arrow = icons.glyphs.get(0xE5C4)!;
  [0.166, 0.166, 0.834, 0.834].forEach((v, i) => assertAlmostEquals(arrow.bounds[i]!, v, 1e-3));
});
