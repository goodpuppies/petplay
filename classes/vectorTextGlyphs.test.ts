import { captureVectorTextGlyphs } from "./vectorTextGlyphs.ts";

Deno.test("vector glyphs retain the layout's kerning, line positions and visible glyph choices", () => {
  const data = captureVectorTextGlyphs({
    _options: { font: { info: { face: "Roboto-Regular", size: 80 }, common: { base: 62 } } },
    visibleGlyphs: [
      { data: { id: 65 }, position: [0, -146] },
      { data: { id: 86 }, position: [47.5, -146] },
      { data: { id: 65 }, position: [17, -62] },
    ],
  });
  if (
    JSON.stringify(Array.from(data!)) !==
      JSON.stringify([65, 0, -84, 80, 0, 86, 47.5, -84, 80, 0, 65, 17, 0, 80, 0])
  ) {
    throw new Error("vector renderer changed existing pen positions or baselines");
  }
});

Deno.test("mixed icon atlas uses icon outlines and Roboto's appended Latin baseline", () => {
  const data = captureVectorTextGlyphs({
    _options: { font: { info: { face: "MaterialIcons-Regular", size: 80 }, common: { base: 80 } } },
    visibleGlyphs: [
      { data: { id: 0xe31b }, position: [0, -80] },
      { data: { id: 0xf6 }, position: [10, -80] },
    ],
  });
  if (data?.[2] !== 0 || data[4] !== 1 || data[7] !== -16 || data[9] !== 0) {
    throw new Error("mixed font metrics lost");
  }
  if (captureVectorTextGlyphs({}) !== undefined) {
    throw new Error("unsupported geometry must retain the MSDF fallback");
  }
});
