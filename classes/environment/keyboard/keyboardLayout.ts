import type {
  KeyboardJsonKeyCell,
  KeyboardLayoutJson,
  KeyboardLayoutMode,
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

/**
 * Axis-aligned size in the same “layout units” as `keyWidth` / `rowH`
 * (multiply by uikit `pixelSize` for scene size). Matches
 * [keyboardUi](keyboardUi.tsx) for the given [KeyboardLayoutMode].
 */
export function keyboardContentBoundsUnits(
  layout: KeyboardLayoutJson,
  format: LayoutFormat,
  mode: KeyboardLayoutMode = "compact",
): { width: number; height: number; depth: number } {
  const { mainRows, navRows, numpadRows, rowH, keyWidth, keyPadding, keyGroupsPadding } =
    getMainGroupRows(layout, format);
  const shellPad = keyGroupsPadding + 2;
  const packH = 2 * shellPad;

  const widthOfRow = (row: RowItem[]): number => {
    let w = 0;
    for (let i = 0; i < row.length; i++) {
      if (i > 0) w += keyPadding;
      const c = row[i]!;
      if ("spacer" in c && c.spacer) w += keyWidth * c.width;
      else w += keyWidth * (c as NormalizedKeyFace).widthMul;
    }
    return w;
  };

  const colWidth = (rows: RowItem[][]): number => {
    let m = 0;
    for (const row of rows) m = Math.max(m, widthOfRow(row));
    return m + 2 * shellPad;
  };

  const colH = (nRows: number) =>
    nRows * rowH + Math.max(0, nRows - 1) * keyPadding + packH;

  const wMain = colWidth(mainRows);
  if (mode === "compact") {
    const h = colH(mainRows.length);
    const depth = rowH * 0.55;
    return { width: wMain, height: h, depth };
  }

  const wNav = colWidth(navRows);
  const wNum = colWidth(numpadRows);
  const totalW = wMain + wNav + wNum + 2 * keyGroupsPadding;

  const h = Math.max(
    colH(mainRows.length),
    colH(navRows.length),
    colH(numpadRows.length),
  );
  const depth = rowH * 0.55;
  return { width: totalW, height: h, depth };
}

/**
 * Same AABB as [keyboardContentBoundsUnits] in meters (multiply by uikit `pixelSize`).
 */
export function keyboardContentBoundsMeters(
  layout: KeyboardLayoutJson,
  format: LayoutFormat,
  pixelSize: number,
  mode: KeyboardLayoutMode = "compact",
): { width: number; height: number; depth: number } {
  const u = keyboardContentBoundsUnits(layout, format, mode);
  return {
    width: u.width * pixelSize,
    height: u.height * pixelSize,
    depth: u.depth * pixelSize,
  };
}

/**
 * Latched “down” look for [InteractiveKeyCap](keyboardKeyInteraction.tsx): caps, shift, ctrl, alt, meta
 * (matches [handleKey] in `keyboardUi.tsx` scan codes).
 */
export function isModifierLatchedVisual(
  face: NormalizedKeyFace,
  mods: ModifierSnapshot,
): boolean {
  if (face.useVirtualKeyCode) return false;
  const hi = face.scanCodeHex.toUpperCase();
  if (face.toggle && hi === "3A") return mods.caps;
  if (!face.sticky) return false;
  if (hi === "2A" || hi === "36") return mods.shift;
  if (hi === "1D") return mods.leftCtrl;
  if (hi === "E01D") return mods.rightCtrl;
  if (hi === "38") return mods.leftAlt;
  if (hi === "E038") return mods.rightAlt;
  if (hi === "E05B") return mods.leftMeta;
  if (hi === "E05C") return mods.rightMeta;
  return false;
}
