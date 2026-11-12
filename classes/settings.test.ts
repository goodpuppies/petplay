import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  defaultSettings,
  getSetting,
  loadSettings,
  parseSettings,
  setSetting,
  subscribeSettings,
} from "./settings.ts";

Deno.test("parseSettings keeps valid known keys, defaults invalid ones, keeps unknown keys", () => {
  const { settings, extra } = parseSettings(
    JSON.stringify({ grabboxOutline: false, controllerLaser: "yes", futureThing: 3 }),
  );
  assertEquals(settings.grabboxOutline, false);
  assertEquals(settings.controllerLaser, defaultSettings().controllerLaser);
  assertEquals(extra, { futureThing: 3 });
});

Deno.test("parseSettings falls back to defaults on junk", () => {
  assertEquals(parseSettings("not json").settings, defaultSettings());
  assertEquals(parseSettings("[1,2]").settings, defaultSettings());
});

Deno.test("text comparison settings validate and preserve independent choices", () => {
  const parsed = parseSettings(JSON.stringify({ textRenderer: "pathfinder", panoramaFilter: "linear" }));
  assertEquals(parsed.settings.textRenderer, "pathfinder");
  assertEquals(parsed.settings.panoramaFilter, "linear");
  assertEquals(parseSettings('{"textRenderer":"glyph"}').settings.textRenderer, "glyph");
  assertEquals(parseSettings('{"textRenderer":"windfoil"}').settings.textRenderer, "windfoil");
  const invalid = parseSettings(JSON.stringify({ textRenderer: "unknown", panoramaFilter: "nearest" }));
  assertEquals(invalid.settings.textRenderer, null);
  assertEquals(invalid.settings.panoramaFilter, null);
});

Deno.test("Glyph tuning accepts bounded independent settings and rejects invalid values", () => {
  assertEquals(parseSettings('{"glyphAaWidth":0.85}').settings.glyphAaWidth, 0.85);
  for (const value of [0, 0.49, 1.01, "0.85", null]) {
    assertEquals(parseSettings(JSON.stringify({glyphAaWidth:value})).settings.glyphAaWidth, 1);
  }
  const valid = parseSettings('{"glyphCoverageExponent":0.85,"glyphWeightPixels":0.125}').settings;
  assertEquals(valid.glyphCoverageExponent, 0.85);
  assertEquals(valid.glyphWeightPixels, 0.125);
  for (const value of [-1, 1.1, "0.7", null]) {
    assertEquals(parseSettings(JSON.stringify({glyphCoverageExponent:value})).settings.glyphCoverageExponent, 1);
  }
  for (const value of [-0.1, 0.26, "0.125", null]) {
    assertEquals(parseSettings(JSON.stringify({glyphWeightPixels:value})).settings.glyphWeightPixels, 0);
  }
});

Deno.test("setSetting persists, round-trips and preserves unknown keys", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/settings.json`;
  Deno.writeTextFileSync(path, JSON.stringify({ futureThing: 3 }));
  loadSettings(path);
  let notified = 0;
  const unsubscribe = subscribeSettings(() => notified++);
  setSetting("controllerLaser", false);
  setSetting("controllerLaser", false); // unchanged: no write, no event
  unsubscribe();
  assertEquals(notified, 1);
  const written = JSON.parse(Deno.readTextFileSync(path));
  assertEquals(written.controllerLaser, false);
  assertEquals(written.futureThing, 3);
  loadSettings(path);
  assertEquals(getSetting("controllerLaser"), false);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("setSetting rejects invalid values", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => setSetting("grabboxOutline", "on" as any));
});
