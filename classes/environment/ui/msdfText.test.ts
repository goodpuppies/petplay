import { assert } from "@std/assert";
import { measureMsdfText } from "../../../submodules/threewebxrwebgpudeno/msdf-text.tsx";

// Song titles, window titles and desktop notifications reach the UI verbatim. A line that opens
// with characters the font lacks and then a space threw in the layout and took the scene down.
Deno.test("MSDF text lays out lines that open with glyphs the font lacks", async () => {
  for (const text of ["😀 hello", "♪ Song", "日本 語", "Title\n🎉 Artist"]) {
    const metrics = await measureMsdfText(text, 22);
    assert(Number.isFinite(metrics.width), text);
  }
});
