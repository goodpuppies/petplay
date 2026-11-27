/**
 * User settings: one typed store, persisted to `settings.json` in `configDir()` (classes/appPaths.ts)
 * (`PETPLAY_SETTINGS_PATH` overrides).
 *
 * Module state is per isolate. The isolate that owns the scene (the `webxr` actor) loads the file
 * once and writes it back on every change; other readers can load it themselves. Unknown keys in
 * the file are kept, so a newer build's settings survive a run of an older one.
 */
import { dirname, join } from "@std/path";
import { configDir } from "./appPaths.ts";
import { useSyncExternalStore } from "react";
import {
  isWristOffset,
  type PoseOffset,
  type WristOffset,
} from "./environment/wristMenu/offset.ts";

export const SETTINGS_FILENAME = "settings.json";

type SettingSpec<T> = {
  default: T;
  /** One line for a settings surface / `client settings`. */
  label: string;
  valid: (value: unknown) => value is T;
};

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isHand = (value: unknown): value is "left" | "right" => value === "left" || value === "right";
const isWristScale = (value: unknown): value is number =>
  typeof value === "number" && value >= 0.5 && value <= 2;
const isWristOpacity = (value: unknown): value is number =>
  typeof value === "number" && value >= 0.2 && value <= 1;
const isLocaleOrNull = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && /^[a-z]{2,3}$/.test(value));

/** Recording-layer sizes the wrist page cycles through (VRChat's stream presets). */
export const VRC_CAMERA_RESOLUTIONS = ["1920x1080", "1280x720", "2560x1440"] as const;
export type VrcCameraResolution = typeof VRC_CAMERA_RESOLUTIONS[number];

export type OverlayPresentMode = "panorama" | "projection" | "native";

export const SETTINGS_SCHEMA = {
  passthroughKey: {
    default: null as string | null,
    label: "Passthrough sky colour; null disables it",
    valid: (v: unknown): v is string | null =>
      v === null || (typeof v === "string" && /^[0-9a-f]{6}$/i.test(v)),
  } satisfies SettingSpec<string | null>,
  passthroughAnchor: {
    default: "playspace" as "playspace" | "head",
    label: "Passthrough sky anchor",
    valid: (v: unknown): v is "playspace" | "head" => v === "playspace" || v === "head",
  } satisfies SettingSpec<"playspace" | "head">,
  passthroughCenter: {
    default: null as [number, number, number] | null,
    label: "Passthrough sky centre in PetPlay playspace metres; null recentres at the head",
    valid: (v: unknown): v is [number, number, number] | null =>
      v === null ||
      (Array.isArray(v) && v.length === 3 &&
        v.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000)),
  } satisfies SettingSpec<[number, number, number] | null>,
  passthroughRadiusMeters: {
    default: 2 as number,
    label: "Passthrough sky distance in metres (0.25 to 40)",
    valid: (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0.25 && v <= 40,
  } satisfies SettingSpec<number>,
  glyphAaWidth: {
    default: 1 as number,
    label: "Glyph antialiasing footprint scale (1 is original; smaller is sharper)",
    valid: (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 1,
  } satisfies SettingSpec<number>,
  glyphCoverageExponent: {
    default: 1 as number,
    label: "Glyph edge coverage exponent (1 is the original coverage)",
    valid: (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 1,
  } satisfies SettingSpec<number>,
  glyphWeightPixels: {
    default: 0 as number,
    label: "Glyph coverage dilation in eye pixels (0 is the original weight)",
    valid: (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 0.25,
  } satisfies SettingSpec<number>,
  textRenderer: {
    default: null as "msdf" | "pathfinder" | "glyph" | "windfoil" | null,
    label: "Text renderer; null follows the session default",
    valid: (value: unknown): value is "msdf" | "pathfinder" | "glyph" | "windfoil" | null =>
      value === null || value === "msdf" || value === "pathfinder" || value === "glyph" ||
      value === "windfoil",
  } satisfies SettingSpec<"msdf" | "pathfinder" | "glyph" | "windfoil" | null>,
  panoramaFilter: {
    default: null as "linear" | "catmull-rom" | null,
    label: "Panorama reconstruction filter; null follows the session default",
    valid: (value: unknown): value is "linear" | "catmull-rom" | null =>
      value === null || value === "linear" || value === "catmull-rom",
  } satisfies SettingSpec<"linear" | "catmull-rom" | null>,
  overlayPresentMode: {
    default: "panorama" as OverlayPresentMode,
    label:
      "Overlay presentation mode: panorama (default, native quad displays), projection (lower VRAM, head reprojection) or native (panorama, with UI panels as SteamVR quads)",
    valid: (value: unknown): value is OverlayPresentMode =>
      value === "panorama" || value === "projection" || value === "native",
  } satisfies SettingSpec<OverlayPresentMode>,
  grabboxOutline: {
    default: true as boolean,
    label: "Draw grab-box outlines (the hull stays grabbable either way)",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  controllerLaser: {
    default: true as boolean,
    label: "Controller laser beams (pointing works either way)",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  haptics: {
    default: true as boolean,
    label: "Controller vibration on button hover and click",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  spaceMoveEnabled: {
    default: false as boolean,
    label: "Allow playspace drag (Space Move) from the bound controller action",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  updateChannel: {
    default: null as string | null,
    label:
      "Update channel: stable, owner/repo#branch for a CI branch build; null follows the build's own",
    valid: (v: unknown): v is string | null =>
      v === null ||
      (typeof v === "string" && (v === "stable" || /^[\w.-]+\/[\w.-]+#[^\s~^:?*\[\\]+$/.test(v))),
  } satisfies SettingSpec<string | null>,
  updateAutoCheck: {
    default: true as boolean,
    label: "Check for updates on the update channel while PetPlay runs (never installs by itself)",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  updateRepos: {
    default: [] as string[],
    label: "Extra owner/repo forks whose branch builds the channel list shows",
    valid: (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((r) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r)),
  } satisfies SettingSpec<string[]>,
  acceptPeerPatches: {
    default: false as boolean,
    label:
      "Let trusted coop peers live-patch PetPlay's code (function edits only, classes/peerPatch.ts)",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  grabSmoothing: {
    default: 0.3 as number,
    label: "Laser grab smoothing amount (0 off to 1 maximum)",
    valid: (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  } satisfies SettingSpec<number>,
  wristMenuHand: {
    default: "right" as "left" | "right",
    label: "Controller that wears the wrist menu; the other hand points at it",
    valid: isHand,
  } satisfies SettingSpec<"left" | "right">,
  wristMenuScale: {
    default: 1 as number,
    label: "Wrist menu size, relative to the default watch-face size (0.5 to 2)",
    valid: isWristScale,
  } satisfies SettingSpec<number>,
  wristMenuOpacity: {
    default: 1 as number,
    label: "Wrist menu opacity (0.2 to 1); below 1 the controller shows through it",
    valid: isWristOpacity,
  } satisfies SettingSpec<number>,
  wristMenuHideAngle: {
    default: 0 as number,
    label:
      "Hide wrist menu when tilted past this angle from your eyes in degrees (0 = OFF, 5 to 90)",
    valid: (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 90,
  } satisfies SettingSpec<number>,
  contextToolbarScale: {
    default: 1 as number,
    label: "Window side-menu size, relative to the default (0.5 to 2; resized in edit layout mode)",
    valid: isWristScale,
  } satisfies SettingSpec<number>,
  renderScaleByResolution: {
    default: {} as Record<string, number>,
    label:
      "Render resolution relative to SteamVR's, keyed by SteamVR's recommended size \"<width>x<height>\" (Settings → Render)",
    valid: (value: unknown): value is Record<string, number> =>
      value != null && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every((scale) =>
        typeof scale === "number" && scale >= 0.5 && scale <= 2
      ),
  } satisfies SettingSpec<Record<string, number>>,
  laserOffsets: {
    default: {} as Record<string, PoseOffset>,
    label:
      "Each laser's pose relative to its controller's tip, keyed \"<render model>/<hand>\" (edit layout mode)",
    valid: (value: unknown): value is Record<string, PoseOffset> =>
      value != null && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every(isWristOffset),
  } satisfies SettingSpec<Record<string, PoseOffset>>,
  wristMenuOffset: {
    default: null as WristOffset | null,
    label:
      "Where the wrist menu was dragged to, relative to its default mount; null is the default",
    valid: (value: unknown): value is WristOffset | null => value === null || isWristOffset(value),
  } satisfies SettingSpec<WristOffset | null>,
  vrcCameraResolution: {
    default: "1920x1080" as VrcCameraResolution,
    label: "VRC camera recording layer size; match VRChat's stream resolution",
    valid: (value: unknown): value is VrcCameraResolution =>
      (VRC_CAMERA_RESOLUTIONS as readonly unknown[]).includes(value),
  } satisfies SettingSpec<VrcCameraResolution>,
  desktopNotifications: {
    default: true as boolean,
    label: "Show desktop notifications in the headset as toasts (Linux)",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  typingSounds: {
    default: true as boolean,
    label: "Click sounds from the keyboard, played where the key is",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  keyboardLocale: {
    default: null as string | null,
    label: "Keyboard legend locale; null follows --keyboard-locale / the host layout",
    valid: isLocaleOrNull,
  } satisfies SettingSpec<string | null>,
  stageforgeNetworking: {
    default: true as boolean,
    label: "Enable peer-to-peer networking (iroh + topic server) for VRChat/household sharing",
    valid: isBoolean,
  } satisfies SettingSpec<boolean>,
  grabThreshold: {
    default: 0.45 as number,
    label: "Index grip squeeze force required to grab (0.05 to 0.95)",
    valid: (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0.05 && v <= 0.95,
  } satisfies SettingSpec<number>,
};

export type Settings = {
  [K in keyof typeof SETTINGS_SCHEMA]: (typeof SETTINGS_SCHEMA)[K]["default"];
};
export type SettingKey = keyof Settings;

export function defaultSettings(): Settings {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) out[key] = spec.default;
  return out as Settings;
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key);
}

export function isValidSetting<K extends SettingKey>(key: K, value: unknown): value is Settings[K] {
  return (SETTINGS_SCHEMA[key].valid as (value: unknown) => boolean)(value);
}

/** Known keys with valid values win; invalid ones fall back to the default; unknown keys are kept. */
export function parseSettings(
  text: string,
): { settings: Settings; extra: Record<string, unknown> } {
  const settings = defaultSettings();
  const extra: Record<string, unknown> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings, extra };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { settings, extra };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSettingKey(key)) extra[key] = value;
    else if (isValidSetting(key, value)) (settings as Record<string, unknown>)[key] = value;
  }
  return { settings, extra };
}

export function getSettingsPath(): string {
  const override = Deno.env.get("PETPLAY_SETTINGS_PATH");
  if (override) return override;
  return join(configDir(), SETTINGS_FILENAME);
}

let current: Settings = defaultSettings();
let extraKeys: Record<string, unknown> = {};
/** Where changes are written; null until `loadSettings` runs, so tests and readers stay in memory. */
let persistPath: string | null = null;
const listeners = new Set<() => void>();

/** Load the file (missing → defaults) and persist later changes to it. */
export function loadSettings(path = getSettingsPath()): Settings {
  try {
    const parsed = parseSettings(Deno.readTextFileSync(path));
    current = parsed.settings;
    extraKeys = parsed.extra;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`[settings] could not load ${path}`, error);
    }
    current = defaultSettings();
    extraKeys = {};
  }
  persistPath = path;
  emit();
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return current[key];
}

/** Throws on an invalid value, so a bad REPL/actor call fails loudly instead of persisting junk. */
export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  if (!isValidSetting(key, value)) {
    throw new Error(`invalid value for setting "${key}": ${JSON.stringify(value)}`);
  }
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  save();
  emit();
}

export function resetSettings(): void {
  current = defaultSettings();
  save();
  emit();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  const read = () => current[key];
  return useSyncExternalStore(subscribeSettings, read, read);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function save(): void {
  if (persistPath == null) return;
  const path = persistPath;
  const temporaryPath = `${path}.${Deno.pid}.tmp`;
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(
      temporaryPath,
      `${JSON.stringify({ ...extraKeys, ...current }, null, 2)}\n`,
    );
    Deno.renameSync(temporaryPath, path);
  } catch (error) {
    try {
      Deno.removeSync(temporaryPath);
    } catch {
      // Nothing temporary was left behind.
    }
    console.warn(`[settings] could not save ${path}`, error);
  }
}
