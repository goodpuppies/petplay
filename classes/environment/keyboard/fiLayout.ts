import type { KeyboardLocaleKey } from "./types.ts";
import { US_KEYS } from "./usLayout.ts";

/**
 * Finnish `KBDFI`, expressed as the differences from [US_KEYS].
 *
 * Finnish is QWERTY, so nothing not listed here differs from US: the letter
 * rows, function keys and nav keys (including `Shift`, `Ctrl`, `Alt`, `Win` and
 * their icons) are shared.
 *
 * Sources, in agreement on every entry below:
 * - `/usr/share/X11/xkb/symbols/fi` — `kotoistus` (SFS 5966) and its `winkeys`
 *   variant, which exists to mirror the Windows layout.
 * - <https://kbdlayout.info/KBDFI> — the reference `resources/Keyboard.json`
 *   points at for scancodes.
 *
 * `winkeys` also pulls `eurosign(5)` in, i.e. AltGr+5 is `€` there where bare
 * SFS 5966 puts `‰`; the Windows legend wins, matching the `SendInput` sink.
 * Level 4 (Shift+AltGr) is not modelled: the caps carry one AltGr legend, and
 * the host layout still decides what the injected scancode produces.
 *
 * `27`/`28`/`1A` are `ö`/`ä`/`å` here where US has `;`/`'`/`[`, and `2B` is `'`
 * where US has `\` — which is why `letter` is per-locale rather than derived
 * from the scancode range.
 */
const FI_OVERRIDES: Record<string, KeyboardLocaleKey> = {
  "29": { base: "§", shift: "½" },
  "03": { base: "2", shift: '"', altGr: "@" },
  "04": { base: "3", shift: "#", altGr: "£" },
  "05": { base: "4", shift: "¤", altGr: "$" },
  "06": { base: "5", shift: "%", altGr: "€" },
  "07": { base: "6", shift: "&" },
  "08": { base: "7", shift: "/", altGr: "{" },
  "09": { base: "8", shift: "(", altGr: "[" },
  "0A": { base: "9", shift: ")", altGr: "]" },
  "0B": { base: "0", shift: "=", altGr: "}" },
  "0C": { base: "+", shift: "?", altGr: "\\" },
  "0D": { base: "´", shift: "`" },
  "1A": { base: "å", shift: "Å", letter: true },
  "1B": { base: "¨", shift: "^" },
  "27": { base: "ö", shift: "Ö", letter: true },
  "28": { base: "ä", shift: "Ä", letter: true },
  "2B": { base: "'", shift: "*" },
  "33": { base: ",", shift: ";" },
  "34": { base: ".", shift: ":" },
  "35": { base: "-", shift: "_" },
  /** ISO-only key left of `Z`; absent from the ANSI rows. */
  "56": { base: "<", shift: ">", altGr: "|" },
};

export const FI_KEYS: Record<string, KeyboardLocaleKey> = {
  ...US_KEYS,
  ...FI_OVERRIDES,
};
