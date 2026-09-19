import { useSyncExternalStore } from "react";
import { LogChannel } from "@mommysgoodpuppy/logchannel";
import type {
  KeyboardLocale,
  KeyboardLocaleId,
  KeyboardLocaleKey,
  LayoutFormat,
} from "./types.ts";
import { US_KEYS } from "./usLayout.ts";
import { FI_KEYS } from "./fiLayout.ts";

export type {
  KeyboardLocale,
  KeyboardLocaleId,
  KeyboardLocaleKey,
} from "./types.ts";

/** Ids must also exist in [KeyboardLocaleId](types.ts); this record owns their tables. */
export const KEYBOARD_LOCALES: Record<KeyboardLocaleId, KeyboardLocale> = {
  us: { id: "us", label: "English (US)", format: "ansi", keys: US_KEYS },
  fi: { id: "fi", label: "Suomi", format: "iso", keys: FI_KEYS },
};

export const DEFAULT_KEYBOARD_LOCALE_ID: KeyboardLocaleId = "us";

const LOCALE_ARG_PREFIX = "--keyboard-locale=";
const LOCALE_ENV_VAR = "PETPLAY_KEYBOARD_LOCALE";

/** Legend shown for scancodes the locale does not name (and unknown cells). */
const UNKNOWN_KEY_LEGEND = "·";

export function isKeyboardLocaleId(value: string): value is KeyboardLocaleId {
  return Object.prototype.hasOwnProperty.call(KEYBOARD_LOCALES, value);
}

/**
 * Unknown ids throw instead of falling back: a typo in `--keyboard-locale=fin`
 * must not silently render another locale's legends over the host's keys.
 */
export function resolveKeyboardLocale(id?: string | null): KeyboardLocale {
  if (id == null || id === "") {
    return KEYBOARD_LOCALES[DEFAULT_KEYBOARD_LOCALE_ID];
  }
  if (!isKeyboardLocaleId(id)) {
    throw new Error(
      `unknown keyboard locale "${id}"; known: ${Object.keys(KEYBOARD_LOCALES).join(", ")}`,
    );
  }
  return KEYBOARD_LOCALES[id];
}

export function localeKeyFor(
  locale: KeyboardLocale,
  codeHex: string,
): KeyboardLocaleKey | undefined {
  return locale.keys[codeHex.toUpperCase()];
}

export type KeyLegendModifiers = {
  shift: boolean;
  caps: boolean;
  /** AltGr — right alt (level 3). */
  altGr?: boolean;
};

export type ResolvedKeyLegend = {
  /** Legend for the current modifiers (level 3 when AltGr is held). */
  main: string;
  shiftLabel: string;
  altGrLabel: string | undefined;
};

/**
 * Legend for one key at the given modifiers.
 *
 * `respectCapsLock` says whether Caps Lock swaps the two cases here — true for
 * letters of the locale, so a caps-only `ö` key reads `Ö`. AltGr wins over
 * Shift: level 3 is a separate legend, not a third case of `base`/`shift`.
 */
export function keyLegendFromScan(
  locale: KeyboardLocale,
  codeHex: string,
  mods: KeyLegendModifiers,
  respectCapsLock: boolean,
): ResolvedKeyLegend {
  const key = localeKeyFor(locale, codeHex);
  if (key == null) {
    return {
      main: UNKNOWN_KEY_LEGEND,
      shiftLabel: UNKNOWN_KEY_LEGEND,
      altGrLabel: undefined,
    };
  }
  const shifted = respectCapsLock ? mods.shift !== mods.caps : mods.shift;
  return {
    main: mods.altGr === true && key.altGr != null
      ? key.altGr
      : shifted
      ? key.shift
      : key.base,
    shiftLabel: key.shift,
    altGrLabel: key.altGr,
  };
}

export function scanCodeHexToNumber(hex: string): number {
  return parseInt(hex.replace(/^0x/i, ""), 16);
}

/** Where the active locale id came from; surfaced for diagnostics. */
export type KeyboardLocaleSource = "arg" | "env" | "host-layout" | "runtime" | "default";

/** Active locale and where it was chosen — for status readouts, not behaviour. */
export function getKeyboardLocaleInfo(): {
  id: KeyboardLocaleId;
  source: KeyboardLocaleSource;
} {
  return { id: getKeyboardLocaleId(), source: currentLocaleSource ?? "default" };
}

function requestedKeyboardLocaleId(): { id: string | null; source: KeyboardLocaleSource } {
  const fromArgs = Deno.args
    .find((arg) => arg.startsWith(LOCALE_ARG_PREFIX))
    ?.slice(LOCALE_ARG_PREFIX.length);
  if (fromArgs != null && fromArgs.length > 0) {
    return { id: fromArgs, source: "arg" };
  }
  const fromEnv = Deno.env.get(LOCALE_ENV_VAR);
  if (fromEnv != null && fromEnv.length > 0) {
    return { id: fromEnv, source: "env" };
  }
  const fromHost = hostKeyboardLocaleId();
  if (fromHost != null) {
    return { id: fromHost, source: "host-layout" };
  }
  return { id: null, source: "default" };
}

/**
 * The host's own keyboard layout, so the caps match the keys the OS will read
 * the injected scancodes with. `localectl` is the portable answer on a Wayland
 * session (`setxkbmap` there reports XWayland's copy, not the compositor's), and
 * a locale we do not have a table for simply leaves the default in place — a
 * wrong guess would relabel every key.
 */
function hostKeyboardLocaleId(): string | null {
  if (Deno.build.os !== "linux") {
    return null;
  }
  try {
    const result = new Deno.Command("localectl", {
      args: ["status"],
      stdout: "piped",
      stderr: "null",
      stdin: "null",
    }).outputSync();
    if (!result.success) {
      return null;
    }
    const text = new TextDecoder().decode(result.stdout);
    const match = text.match(/^\s*(?:X11 Layout|VC Keymap):\s*(.+)$/m);
    const code = match?.[1]?.split(",")[0]?.trim().toLowerCase();
    return code != null && code.length > 0 && isKeyboardLocaleId(code) ? code : null;
  } catch {
    // No localectl (non-systemd host, or a sandbox without it): keep the default.
    return null;
  }
}

let currentLocaleId: KeyboardLocaleId | null = null;
let currentLocaleSource: KeyboardLocaleSource | null = null;
const localeListeners = new Set<() => void>();

/** Active locale id; resolved once from the launch args / env / host layout, then frozen until set. */
export function getKeyboardLocaleId(): KeyboardLocaleId {
  if (currentLocaleId == null) {
    const requested = requestedKeyboardLocaleId();
    currentLocaleId = resolveKeyboardLocale(requested.id).id;
    currentLocaleSource = requested.source;
    LogChannel.log(
      "actor",
      `[keyboard] locale ${currentLocaleId} (${requested.source})`,
    );
  }
  return currentLocaleId;
}

export function getKeyboardLocale(): KeyboardLocale {
  return KEYBOARD_LOCALES[getKeyboardLocaleId()];
}

export function keyboardFormatFor(locale: KeyboardLocale, format?: LayoutFormat): LayoutFormat {
  return format ?? locale.format;
}

/**
 * Switch locale at runtime (settings UI, agent-REPL `/eval`). Renders that read
 * [useKeyboardLocale] relabel on the next React pass.
 */
export function setKeyboardLocale(id: string): KeyboardLocale {
  const next = resolveKeyboardLocale(id);
  if (currentLocaleId === next.id) {
    return next;
  }
  currentLocaleId = next.id;
  currentLocaleSource = "runtime";
  for (const listener of [...localeListeners]) {
    listener();
  }
  return next;
}

export function subscribeKeyboardLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

/** Active locale for components; re-renders them on [setKeyboardLocale]. */
export function useKeyboardLocale(): KeyboardLocale {
  return useSyncExternalStore(
    subscribeKeyboardLocale,
    getKeyboardLocale,
    getKeyboardLocale,
  );
}
