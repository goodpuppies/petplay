import {
  DEFAULT_KEYBOARD_LOCALE_ID,
  getKeyboardLocaleId,
  getKeyboardLocaleInfo,
  KEYBOARD_LOCALES,
  keyLegendFromScan,
  resolveKeyboardLocale,
  setKeyboardLocale,
  subscribeKeyboardLocale,
} from "./keyboardLocale.ts";
import { getMainGroupRows, resolveLabel, type RowItem } from "./keyboardLayout.ts";
import { getDefaultKeyboardLayoutSync } from "./defaultLayoutPreload.ts";
import type { KeyboardLocaleId, ModifierSnapshot, NormalizedKeyFace } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mods(overrides: Partial<ModifierSnapshot>): ModifierSnapshot {
  return {
    shift: false,
    caps: false,
    leftCtrl: false,
    rightCtrl: false,
    leftAlt: false,
    rightAlt: false,
    leftMeta: false,
    rightMeta: false,
    ...overrides,
  };
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, received ${a}`);
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

function faceByScan(rows: RowItem[][], hex: string): NormalizedKeyFace {
  for (const row of rows) {
    for (const item of row) {
      if ("spacer" in item && item.spacer) continue;
      const face = item as NormalizedKeyFace;
      if (face.scanCodeHex === hex) return face;
    }
  }
  throw new Error(`no key face for scancode ${hex}`);
}

const layout = getDefaultKeyboardLayoutSync();
const noMods = { shift: false, caps: false };

Deno.test("locale registry: defaults resolve to a registered locale, FI is ISO, unknown ids throw", () => {
  // The default follows the host's keyboard layout (localectl on Linux), so the
  // resolved id is machine-dependent: assert the contract, not this host.
  const info = getKeyboardLocaleInfo();
  assert(
    Object.keys(KEYBOARD_LOCALES).includes(info.id),
    `active locale ${info.id} must be a registered locale`,
  );
  assert(
    ["arg", "env", "host-layout", "runtime", "default"].includes(info.source),
    `unexpected locale source ${info.source}`,
  );
  assertEquals(info.id, getKeyboardLocaleId(), "the info seam reports the active locale");
  // Explicit resolution has no host probe in it: no id means the project default.
  assertEquals(
    resolveKeyboardLocale().id,
    DEFAULT_KEYBOARD_LOCALE_ID,
    "an omitted id resolves to the project default",
  );
  assertEquals(resolveKeyboardLocale("us").format, "ansi", "US rows come from the ANSI set");
  assertEquals(resolveKeyboardLocale("fi").format, "iso", "FI needs the ISO `<`/`>` key");
  assertThrows(
    () => resolveKeyboardLocale("fin"),
    "a typo'd locale id must throw, not silently render US legends",
  );
});

Deno.test("caps lock follows the locale's letters, not the US scancode rows", () => {
  const fi = resolveKeyboardLocale("fi");
  // `27` is `ö` in FI and `;` in US; the JSON marks neither as caps-respecting.
  assertEquals(
    keyLegendFromScan(fi, "27", { shift: false, caps: true }, true).main,
    "Ö",
    "caps-only ö key reads Ö",
  );
  assertEquals(
    keyLegendFromScan(fi, "27", { shift: true, caps: true }, true).main,
    "ö",
    "shift+caps cancels out, as on letters",
  );
  const us = resolveKeyboardLocale("us");
  assertEquals(
    keyLegendFromScan(us, "27", { shift: false, caps: true }, false).main,
    ";",
    "caps lock leaves US punctuation alone",
  );
  assertEquals(
    keyLegendFromScan(us, "27", { shift: true, caps: true }, false).main,
    ":",
    "caps lock does not cancel shift on US punctuation",
  );
});

Deno.test("Finnish rows carry Finnish legends over the real Keyboard.json", () => {
  const fi = resolveKeyboardLocale("fi");
  const { mainRows } = getMainGroupRows(layout, "iso", fi);

  const aumlaut = faceByScan(mainRows, "28");
  assertEquals(aumlaut.displayMain, "ä", "28 is ä, not the US apostrophe");
  assert(aumlaut.respectCapsLock, "ä must respect caps lock even though the JSON does not say so");
  assertEquals(
    resolveLabel(aumlaut, mods({ caps: true }), fi),
    "Ä",
    "caps lock uppercases ä",
  );

  const oumlaut = faceByScan(mainRows, "27");
  assertEquals([oumlaut.displayMain, oumlaut.respectCapsLock], ["ö", true], "27 is caps-aware ö");

  const ring = faceByScan(mainRows, "1A");
  assertEquals(ring.displayMain, "å", "1A is å, not the US bracket");

  const isoKey = faceByScan(mainRows, "56");
  assertEquals(
    [isoKey.displayMain, isoKey.hasSecondary, isoKey.displayAlt],
    ["<", true, "|"],
    "the ISO-only key shows < with its AltGr legend",
  );

  const seven = faceByScan(mainRows, "08");
  assertEquals(
    [seven.displayMain, seven.displayAlt],
    ["7", "{"],
    "AltGr legends render as the cap's secondary legend",
  );

  const acute = faceByScan(mainRows, "0D");
  assertEquals(acute.displayMain, "´", "0D is the dead acute key, not `=`");
});

Deno.test("US rows are unchanged by the locale layer", () => {
  const us = resolveKeyboardLocale("us");
  const { mainRows } = getMainGroupRows(layout, "ansi", us);

  const quote = faceByScan(mainRows, "28");
  assertEquals(
    [quote.displayMain, quote.respectCapsLock, quote.hasSecondary],
    ["'", false, false],
    "US keeps its apostrophe and no secondary legend",
  );
  assertEquals(faceByScan(mainRows, "0D").displayMain, "=", "US keeps `=`");
  assertEquals(faceByScan(mainRows, "2B").displayMain, "\\", "US keeps the backslash key");
  assert(
    mainRows.every((row) =>
      row.every((item) =>
        ("spacer" in item && item.spacer) ||
        (item as NormalizedKeyFace).scanCodeHex !== "56"
      )
    ),
    "ANSI rows do not carry the ISO-only key",
  );
});

Deno.test("AltGr resolves to the level-3 legend and falls back where a locale has none", () => {
  const fi = resolveKeyboardLocale("fi");
  assertEquals(
    keyLegendFromScan(fi, "09", { shift: false, caps: false, altGr: true }, false),
    { main: "[", shiftLabel: "(", altGrLabel: "[" },
    "AltGr+8 types [ on FI",
  );
  assertEquals(
    keyLegendFromScan(fi, "28", { shift: false, caps: false, altGr: true }, true).main,
    "ä",
    "a key with no AltGr entry keeps its base legend",
  );
  const us = resolveKeyboardLocale("us");
  assertEquals(
    keyLegendFromScan(us, "09", { shift: false, caps: false, altGr: true }, false).main,
    "8",
    "US has no level 3, so AltGr falls back to the unshifted legend",
  );
  assertEquals(
    keyLegendFromScan(fi, "FF", noMods, false).main,
    "·",
    "scancodes the locale does not name render as the placeholder",
  );
});

Deno.test("setKeyboardLocale notifies subscribers once per change and validates ids", () => {
  const initial = getKeyboardLocaleId();
  const other: KeyboardLocaleId = initial === "fi" ? "us" : "fi";
  try {
    let notifications = 0;
    const unsubscribe = subscribeKeyboardLocale(() => {
      notifications += 1;
    });
    setKeyboardLocale(other);
    assertEquals(getKeyboardLocaleId(), other, "switch takes effect");
    assertEquals(getKeyboardLocaleInfo().source, "runtime", "a switch records its source");
    setKeyboardLocale(other);
    assertEquals(notifications, 1, "setting the active id again does not re-render");
    assertThrows(() => setKeyboardLocale("nope"), "unknown ids throw");
    setKeyboardLocale(initial);
    assertEquals(notifications, 2, "switching back notifies");
    unsubscribe();
  } finally {
    setKeyboardLocale(initial);
  }
});
