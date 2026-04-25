
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
};

export type KeyboardLogicEvent = {
  kind: "key";
  scanCode: number;
  /** Best-effort US QWERTY char with current modifiers, if applicable. */
  char?: string;
} | {
  kind: "modifier";
  /** Modifier changed (toggle or sticky) — for debugging / future IPC. */
  modifier: "shift" | "caps" | "ctrl" | "alt" | "altgr";
  active: boolean;
};

export type KeyboardSink = (event: KeyboardLogicEvent) => void;

export type WorldKeyboardPanelProps = {
  /** Scene transform (meters + radians, Euler order default XYZ). */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  onKey?: KeyboardSink;
  /** Optional: override layout path (default: `resources/Keyboard.json`). */
  layoutUrl?: URL;
};
