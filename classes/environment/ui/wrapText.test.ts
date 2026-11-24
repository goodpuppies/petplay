import { assertEquals } from "@std/assert";
import { truncateText, wrapText } from "./wrapText.ts";

// One unit per character keeps the expected breaks readable.
const measure = (line: string) => Promise.resolve(line.length);

Deno.test("wrapText breaks at the last space that fits", async () => {
  assertEquals(
    await wrapText("the quick brown fox jumps", 10, measure),
    "the quick\nbrown fox\njumps",
  );
});

Deno.test("wrapText keeps short text, existing newlines and overlong words", async () => {
  assertEquals(await wrapText("short", 10, measure), "short");
  assertEquals(await wrapText("a b\nc d", 10, measure), "a b\nc d");
  assertEquals(
    await wrapText("tiny supercalifragilistic end", 10, measure),
    "tiny\nsupercalifragilistic\nend",
  );
});

Deno.test("truncateText keeps what fits and ellipsizes the rest", async () => {
  assertEquals(await truncateText("short", 10, measure), "short");
  assertEquals(await truncateText("the quick brown fox", 10, measure), "the quick…");
  assertEquals(await truncateText("abcdefghijkl", 5, measure), "abcd…");
});
