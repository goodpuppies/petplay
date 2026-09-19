
export type KeyboardJsonKeyCell = {
  keycode?: string;
  keycodes?: string[];
  spacer?: boolean | string;
  width?: number;
  height?: number;
  color?: string;
  highlightColor?: string;
  fontSize?: number;
  label?: string;
  icon?: string;
  iconSize?: number;
  audio?: string;
  secondaryLabel?: string;
  respectCapsLock?: boolean;
  toggle?: boolean;
  sticky?: boolean;
  isDoubleTappable?: boolean;
  useVirtualKeyCode?: boolean;
};

export type KeyboardJsonMainGroup = {
  ansiRows: KeyboardJsonKeyCell[][];
  isoRows: KeyboardJsonKeyCell[][];
  jisRows: KeyboardJsonKeyCell[][];
};

export type KeyboardJsonNavGroup = {
  rows: KeyboardJsonKeyCell[][];
};

export type KeyboardJsonGroups = {
  mainGroup: KeyboardJsonMainGroup;
  navigationGroup: KeyboardJsonNavGroup;
  minimalNavigationGroup: KeyboardJsonNavGroup;
  numpadGroup: KeyboardJsonNavGroup;
};

export type KeyboardLayoutJson = {
  keyWidth: number;
  keyPadding: number;
  keyHaptic: number;
  keyGroupsPadding: number;
  keyboardGroups: KeyboardJsonGroups;
};

export type LayoutFormat = "ansi" | "iso" | "jis";

/**
 * Keyboard locals with a legend table — see [keyboardLocale](keyboardLocale.ts).
 * A new locale needs its table *and* its id here.
 */
export type KeyboardLocaleId = "us" | "fi";

/** Legends for one physical key, per shift state. */
export type KeyboardLocaleKey = {
  base: string;
  shift: string;
  /** AltGr (right alt / level 3) legend. Absent = the key has no AltGr entry. */
  altGr?: string;
  /** Caps Lock swaps [base] and [shift], as it does for letters. */
  letter?: boolean;
};

/**
 * One typing locale: the legends printed on the caps, plus the physical format
 * that carries every key the locale reaches.
 *
 * Legends are set-1 make-codes (hex) because that is the scancode space
 * [Keyboard.json](resources/Keyboard.json) is written in and the space the OS
 * input sinks deliver; the characters a key *produces* are still decided by the
 * host layout, which should be the same one the locale names.
 */
export type KeyboardLocale = {
  id: KeyboardLocaleId;
  /** Human-readable name (logs, future settings UI). */
  label: string;
  /** `Keyboard.json` row set used when [WorldKeyboardPanelProps.layoutFormat] is not set. */
  format: LayoutFormat;
  /** Key legends by set-1 make-code. */
  keys: Record<string, KeyboardLocaleKey>;
};

/**
 * - `compact` - main key block only.
 * - `arrows` - main block plus the nav group's arrow cluster, which is what the
 *   JSON's `navigationGroup` ends with (`SP up SP` / `left down right`). The rows
 *   above the cluster stay as spacers so it lines up with the bottom of the main
 *   block, the way a physical nav cluster does.
 * - `full` - main + nav + numpad.
 */
export type KeyboardLayoutMode = "compact" | "arrows" | "full";

export type NormalizedKeyFace = {
  id: string;
  scanCodeHex: string;
  displayMain: string;
  displayShift: string;
  displayAlt: string;
  hasSecondary: boolean;
  widthMul: number;
  heightMul: number;
  fontSize: number;
  colorToken: "default" | "dark" | "error" | "confirm";
  icon?: string;
  iconSize?: number;
  /** Named native cue from Keyboard.json, e.g. `enter` or `spacebar`. */
  audio?: string;
  labelOverride?: string;
  respectCapsLock: boolean;
  toggle: boolean;
  sticky: boolean;
  useVirtualKeyCode?: boolean;
  virtualName?: string;
};

export type ModifierSnapshot = {
  shift: boolean;
  caps: boolean;
  leftCtrl: boolean;
  rightCtrl: boolean;
  leftAlt: boolean;
  rightAlt: boolean;
  leftMeta: boolean;
  rightMeta: boolean;
};

export type KeyboardLogicEvent = {
  kind: "key";
  /** Legacy aggregate from hex (wrong for E0-prefixed codes); use `scanCodeHex` for OS input. */
  scanCode: number;
  /**
   * Layout make-code as hex (e.g. `2D` for `X` row, `E01D` for right Control).
   * Used to derive extended + scan for `SendInput`.
   */
  scanCodeHex: string;
  /** Best-effort char for the active locale and modifiers, if applicable. */
  char?: string;
  /** Set when the cell used `useVirtualKeyCode` — JSON `keycode` (e.g. `F1`, `ESCAPE`). */
  virtualKeyName?: string;
} | {
  kind: "modifier";
  /** Modifier changed (latch) — for debugging / future IPC. */
  modifier:
    | "shift"
    | "caps"
    | "leftCtrl"
    | "rightCtrl"
    | "leftAlt"
    | "rightAlt"
    | "leftMeta"
    | "rightMeta";
  active: boolean;
};

export type KeyboardSink = (event: KeyboardLogicEvent) => void;

/** Scene props for [KeyboardPanel](keyboard.tsx) — uikit root uses center anchor + flex `relativeCenter` (see uikit `context.ts` / `flex/node.ts`). */
export type WorldKeyboardPanelProps = {
  /** Scene transform (meters + radians, Euler order default XYZ). */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  onKey?: KeyboardSink;
  /** Optional: override layout path (default: `resources/Keyboard.json`). */
  layoutUrl?: URL;
  /** Row set from `Keyboard.json` (default: the locale’s own format). */
  layoutFormat?: LayoutFormat;
  /** Legend locale (default: [getKeyboardLocale](keyboardLocale.ts) — `--keyboard-locale` / env). */
  locale?: KeyboardLocaleId;
  /** `compact` = main only (default); `full` = add nav + numpad. */
  layoutMode?: KeyboardLayoutMode;
  /**
   * Optional nudge in grab-box local space (meters), applied after the uikit is placed.
   * Default `0,0,0`.
   */
  contentOffset?: [number, number, number];
  /** Wireframe tint (hex). Default matches the display grab style. */
  grabLineColor?: number;
};
