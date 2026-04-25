
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
 * - `compact` — main key block only (default): hides navigation (arrows, home…end) and numpad.
 * - `full` — main + nav + numpad.
 */
export type KeyboardLayoutMode = "compact" | "full";

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
  /** Best-effort US QWERTY char with current modifiers, if applicable. */
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
  /** Row set from `Keyboard.json` (default `ansi`). */
  layoutFormat?: LayoutFormat;
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
