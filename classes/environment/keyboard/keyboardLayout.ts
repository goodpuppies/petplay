import type {
  KeyboardJsonKeyCell,
  KeyboardLayoutJson,
  KeyboardLayoutMode,
  KeyboardLocale,
  LayoutFormat,
  ModifierSnapshot,
  NormalizedKeyFace,
} from "./types.ts";
import { keyFaceToToken } from "./theme.ts";
import {
  getKeyboardLocale,
  keyLegendFromScan,
  localeKeyFor,
} from "./keyboardLocale.ts";

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
  locale: KeyboardLocale,
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
      audio: c.audio,
      labelOverride: c.label,
      respectCapsLock: c.respectCapsLock ?? false,
      toggle: c.toggle ?? false,
      sticky: c.sticky ?? false,
      useVirtualKeyCode: true,
      virtualName: name,
    };
  }
  const hx = hexFromCell(c);
  const legend = keyLegendFromScan(locale, hx, { shift: false, caps: false }, false);
  const secondary = c.secondaryLabel ?? legend.altGrLabel;
  return {
    id: `${pre.ns}-r${pre.row}-c${pre.col}-${hx}`,
    scanCodeHex: hx,
    displayMain: c.label ? c.label : legend.main,
    displayShift: c.label ? c.label : legend.shiftLabel,
    displayAlt: secondary ?? "",
    hasSecondary: secondary != null,
    widthMul: c.width ?? 1,
    heightMul: c.height == null ? 1 : c.height,
    fontSize: c.fontSize ?? 20,
    colorToken: keyFaceToToken(c.color, c.highlightColor),
    icon: c.icon,
    iconSize: c.iconSize,
    audio: c.audio,
    labelOverride: c.label,
    // Caps Lock follows the locale’s letters, not the US letter scancode rows:
    // JSON only marks the US letters, and `ö`/`ä`/`å` are not among them.
    respectCapsLock: (c.respectCapsLock ?? false) ||
      (localeKeyFor(locale, hx)?.letter ?? false),
    toggle: c.toggle ?? false,
    sticky: c.sticky ?? false,
  };
}

export type RowItem = NormalizedKeyFace | { spacer: true; width: number; height: number };

export function mapRow(
  row: KeyboardJsonKeyCell[],
  rowIndex: number,
  namespace: string,
  locale: KeyboardLocale,
): RowItem[] {
  const out: RowItem[] = [];
  for (let i = 0; i < row.length; i++) {
    const cell = row[i]!;
    const n = normalizeKeyFace(
      { row: rowIndex, col: i, ns: namespace },
      cell,
      locale,
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
  locale: KeyboardLocale,
): string {
  if (face.labelOverride) {
    return face.labelOverride;
  }
  if (face.useVirtualKeyCode) {
    return face.displayMain;
  }
  const { main } = keyLegendFromScan(
    locale,
    face.scanCodeHex,
    { shift: mods.shift, caps: mods.caps, altGr: mods.rightAlt },
    face.respectCapsLock,
  );
  return main;
}

export function getMainGroupRows(
  layout: KeyboardLayoutJson,
  format: LayoutFormat,
  locale: KeyboardLocale,
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
  const mainRows = mainGroup.map((row, ri) => mapRow(row, ri, "main", locale));
  const navRows = layout.keyboardGroups.navigationGroup.rows.map((row, ri) =>
    mapRow(row, ri, "nav", locale)
  );
  const numpadRows = layout.keyboardGroups.numpadGroup.rows.map((row, ri) =>
    mapRow(row, ri, "numpad", locale)
  );
  const rowH = keyWidth * 0.9;
  return { mainRows, navRows, numpadRows, rowH, keyWidth, keyPadding, keyGroupsPadding };
}

export type KeyboardColumn = {
  id: "main" | "nav" | "numpad";
  rows: RowItem[][];
};

const ARROW_ICONS: Record<string, true> = { up: true, down: true, left: true, right: true };

/**
 * Replace the nav rows above the arrow cluster with spacers, keeping the row
 * count so the cluster lands at the bottom of the board. An arrow row is one
 * whose keys are all arrow icons; the cluster is the trailing run of them.
 */
function navRowsWithArrowsOnly(navRows: RowItem[][]): RowItem[][] {
  let clusterStart = navRows.length;
  for (let i = navRows.length - 1; i >= 0; i--) {
    const keys = navRows[i]!.filter((cell): cell is NormalizedKeyFace =>
      !("spacer" in cell && cell.spacer)
    );
    if (
      keys.length === 0 ||
      !keys.every((key) => key.icon != null && ARROW_ICONS[key.icon] === true)
    ) {
      break;
    }
    clusterStart = i;
  }
  return navRows.map((row, i) =>
    i < clusterStart
      ? row.map((): RowItem => ({ spacer: true, width: 1, height: 1 }))
      : row
  );
}

/**
 * Columns a layout mode renders, in board order. The window UI and
 * [keyboardContentBoundsUnits] both go through this so the grab box cannot
 * describe a board other than the one drawn.
 */
export function keyboardColumns(
  mode: KeyboardLayoutMode,
  rows: { mainRows: RowItem[][]; navRows: RowItem[][]; numpadRows: RowItem[][] },
): KeyboardColumn[] {
  const columns: KeyboardColumn[] = [{ id: "main", rows: rows.mainRows }];
  if (mode === "compact") {
    return columns;
  }
  columns.push({
    id: "nav",
    rows: mode === "arrows" ? navRowsWithArrowsOnly(rows.navRows) : rows.navRows,
  });
  if (mode === "full") {
    columns.push({ id: "numpad", rows: rows.numpadRows });
  }
  return columns;
}

/**
 * Axis-aligned size in the same “layout units” as `keyWidth` / `rowH`
 * (multiply by uikit `pixelSize` for scene size). Matches
 * [keyboardUi](keyboardUi.tsx) for the given [KeyboardLayoutMode].
 *
 * The locale only picks *legends*, which are not measured; it is threaded
 * through because it also picks the format when the caller has none (`fi` is
 * ISO, one key wider than ANSI).
 */
export function keyboardContentBoundsUnits(
  layout: KeyboardLayoutJson,
  format: LayoutFormat,
  mode: KeyboardLayoutMode = "compact",
  locale: KeyboardLocale = getKeyboardLocale(),
): { width: number; height: number; depth: number } {
  const { mainRows, navRows, numpadRows, rowH, keyWidth, keyPadding, keyGroupsPadding } =
    getMainGroupRows(layout, format, locale);
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
  const columns = keyboardColumns(mode, { mainRows, navRows, numpadRows });
  if (columns.length === 1) {
    const h = colH(mainRows.length);
    const depth = rowH * 0.55;
    return { width: wMain, height: h, depth };
  }

  const totalW = columns.reduce((sum, column) => sum + colWidth(column.rows), 0) +
    (columns.length - 1) * keyGroupsPadding;

  const h = Math.max(...columns.map((column) => colH(column.rows.length)));
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
  locale: KeyboardLocale = getKeyboardLocale(),
): { width: number; height: number; depth: number } {
  const u = keyboardContentBoundsUnits(layout, format, mode, locale);
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
