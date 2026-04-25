import type {
  KeyboardJsonKeyCell,
  KeyboardLayoutJson,
  LayoutFormat,
  ModifierSnapshot,
  NormalizedKeyFace,
} from "./types.ts";
import { keyFaceToToken } from "./theme.ts";
import { usQwertyFromScan } from "./usLayout.ts";

export function isSpacer(
  c: KeyboardJsonKeyCell,
): c is KeyboardJsonKeyCell & { spacer: true; width?: number; height?: number } {
  return c.spacer === true || c.spacer === "true" || c.spacer === "True";
}

export function hexFromCell(c: KeyboardJsonKeyCell): string {
  if (c.keycode) {
    return c.keycode;
  }
  if (c.keycodes && c.keycodes[0] !== undefined) {
    return c.keycodes[0]!;
  }
  return "00";
}

export function normalizeKeyFace(
  pre: { row: number; col: number; ns: string },
  c: KeyboardJsonKeyCell,
): NormalizedKeyFace | { spacer: true; width: number; height: number } | null {
  if (isSpacer(c)) {
    return {
      spacer: true,
      width: c.width ?? 1,
      height: c.height ?? 1,
    };
  }
  if (c.useVirtualKeyCode) {
    const name = c.keycode ?? "UNKNOWN";
    return {
      id: `${pre.ns}-r${pre.row}-c${pre.col}-vk`,
      scanCodeHex: "00",
      displayMain: c.label ?? name,
      displayShift: c.label ?? name,
      displayAlt: "",
      hasSecondary: false,
      widthMul: c.width ?? 1,
      heightMul: c.height ?? 1,
      fontSize: c.fontSize ?? 18,
      colorToken: keyFaceToToken(c.color, c.highlightColor),
      icon: c.icon,
      iconSize: c.iconSize,
      labelOverride: c.label,
      respectCapsLock: c.respectCapsLock ?? false,
      toggle: c.toggle ?? false,
      sticky: c.sticky ?? false,
      useVirtualKeyCode: true,
      virtualName: name,
    };
  }
  const hx = hexFromCell(c);
  const m = usQwertyFromScan(
    hx,
    { shift: false, caps: false },
    c.respectCapsLock ?? false,
  );
  return {
    id: `${pre.ns}-r${pre.row}-c${pre.col}-${hx}`,
    scanCodeHex: hx,
    displayMain: c.label ? c.label : m.main,
    displayShift: c.label ? c.label : m.shiftLabel,
    displayAlt: c.secondaryLabel ?? "",
    hasSecondary: Boolean(c.secondaryLabel),
    widthMul: c.width ?? 1,
    heightMul: c.height == null ? 1 : c.height,
    fontSize: c.fontSize ?? 20,
    colorToken: keyFaceToToken(c.color, c.highlightColor),
    icon: c.icon,
    iconSize: c.iconSize,
    labelOverride: c.label,
    respectCapsLock: c.respectCapsLock ?? false,
    toggle: c.toggle ?? false,
    sticky: c.sticky ?? false,
  };
}

export type RowItem = NormalizedKeyFace | { spacer: true; width: number; height: number };

export function mapRow(
  row: KeyboardJsonKeyCell[],
  rowIndex: number,
  namespace: string,
): RowItem[] {
  const out: RowItem[] = [];
  for (let i = 0; i < row.length; i++) {
    const cell = row[i]!;
    const n = normalizeKeyFace(
      { row: rowIndex, col: i, ns: namespace },
      cell,
    );
    if (n != null) {
      out.push(n);
    }
  }
  return out;
}

export function resolveLabel(
  face: NormalizedKeyFace,
  mods: ModifierSnapshot,
): string {
  if (face.labelOverride) {
    return face.labelOverride;
  }
  if (face.useVirtualKeyCode) {
    return face.displayMain;
  }
  const { main } = usQwertyFromScan(
    face.scanCodeHex,
    { shift: mods.shift, caps: mods.caps },
    face.respectCapsLock,
  );
  return main;
}

export function getMainGroupRows(
  layout: KeyboardLayoutJson,
  format: LayoutFormat,
): {
  mainRows: RowItem[][];
  navRows: RowItem[][];
  numpadRows: RowItem[][];
  rowH: number;
  keyWidth: number;
  keyPadding: number;
  keyGroupsPadding: number;
} {
  const { keyWidth, keyPadding, keyGroupsPadding } = layout;
  const mainGroup = format === "iso"
    ? layout.keyboardGroups.mainGroup.isoRows
    : format === "jis"
    ? layout.keyboardGroups.mainGroup.jisRows
    : layout.keyboardGroups.mainGroup.ansiRows;
  const mainRows = mainGroup.map((row, ri) => mapRow(row, ri, "main"));
  const navRows = layout.keyboardGroups.navigationGroup.rows.map((row, ri) =>
    mapRow(row, ri, "nav")
  );
  const numpadRows = layout.keyboardGroups.numpadGroup.rows.map((row, ri) =>
    mapRow(row, ri, "numpad")
  );
  const rowH = keyWidth * 0.9;
  return { mainRows, navRows, numpadRows, rowH, keyWidth, keyPadding, keyGroupsPadding };
}
