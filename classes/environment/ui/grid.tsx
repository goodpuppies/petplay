/**
 * Recursive grid core for PetPlay's overlay UI.
 *
 * Replaces ad-hoc flex rows and manual `units={n}` sizing with two composable primitives:
 *   - {@link Grid}: defines an `N × M` 2D cell grid inside its bounding box (either explicit
 *     `width`/`height` at the root, or inherited automatically from an enclosing {@link Cell}).
 *   - {@link Cell}: occupies `(col, row, colSpan, rowSpan)` inside the nearest {@link Grid},
 *     receiving exact pixel coordinates, size, and concentric corner radius.
 *
 * Invariants enforced by construction at every depth:
 *   1. **Fixed frame**: a Grid's outer size never collapses when cells are omitted — empty
 *      tracks stay empty unless a cell explicitly spans into them.
 *   2. **Spacing rhythm**: `gap` halves with nesting depth (`16 → 8 → 4 → …`) unless overridden.
 *   3. **Concentric radius**: each level's child radius is `parentRadius - inset`, clamped to
 *      `min(w, h) / 2` so small/short cells naturally resolve to circles and pills.
 */
import React, { createContext, useContext, useMemo, useState } from "react";
import type { AllowedPointerEventsType } from "@pmndrs/pointer-events";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { clampRadius, COLOR, GAP, OUTLINE_WIDTH, RADIUS } from "./tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";

export type GridMetrics = {
  /** Outer box width/height (including this grid's own `padding`). */
  outerWidth: number;
  outerHeight: number;
  /** Inner content box width/height (excluding `padding`). */
  innerWidth: number;
  innerHeight: number;
  cols: number;
  rows: number;
  /** Width of one 1×1 cell. */
  colWidth: number;
  /** Height of one 1×1 cell. */
  rowHeight: number;
  gap: number;
  padding: number;
  /** Outer corner radius of this grid container. */
  radius: number;
  /** Derived concentric corner radius for children of this grid (before per-cell clamping). */
  childRadius: number;
  depth: number;
};

export type CellRect = {
  /** Offset from the grid's outer top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Concentric corner radius clamped to this cell's box (or full round when `shape="round"`). */
  radius: number;
  depth: number;
};

/** Pure geometry solver for one grid level. */
export function computeGridMetrics(options: {
  width: number;
  height: number;
  cols: number;
  rows: number;
  gap: number;
  padding: number;
  radius: number;
  depth: number;
}): GridMetrics {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const padding = Math.max(0, options.padding);
  const gap = Math.max(0, options.gap);
  const innerWidth = Math.max(0, options.width - padding * 2);
  const innerHeight = Math.max(0, options.height - padding * 2);
  const colWidth = (innerWidth - gap * (cols - 1)) / cols;
  const rowHeight = (innerHeight - gap * (rows - 1)) / rows;
  const inset = padding > 0 ? padding : gap;
  const childRadius = Math.max(0, options.radius - inset);
  return {
    outerWidth: options.width,
    outerHeight: options.height,
    innerWidth,
    innerHeight,
    cols,
    rows,
    colWidth,
    rowHeight,
    gap,
    padding,
    radius: options.radius,
    childRadius,
    depth: options.depth,
  };
}

/** Pure geometry solver for a cell at `(col, row)` spanning `(colSpan, rowSpan)`. */
export function computeCellRect(
  grid: GridMetrics,
  col: number,
  row: number,
  colSpan = 1,
  rowSpan = 1,
  shape: "concentric" | "round" = "concentric",
): CellRect {
  const width = colSpan * grid.colWidth + Math.max(0, colSpan - 1) * grid.gap;
  const height = rowSpan * grid.rowHeight + Math.max(0, rowSpan - 1) * grid.gap;
  const x = grid.padding + col * (grid.colWidth + grid.gap);
  const y = grid.padding + row * (grid.rowHeight + grid.gap);
  const targetRadius = shape === "round" ? 999 : grid.childRadius;
  const radius = clampRadius(targetRadius, width, height);
  return { x, y, width, height, radius, depth: grid.depth + 1 };
}

const GridContext = createContext<GridMetrics | null>(null);
const CellContext = createContext<CellRect | null>(null);

/** Read the enclosing Grid's resolved metrics. */
export function useGridMetrics(): GridMetrics {
  const ctx = useContext(GridContext);
  if (!ctx) throw new Error("useGridMetrics() must be used inside a <Grid>");
  return ctx;
}

/** Read the enclosing Cell's resolved pixel rect and radius (null at root). */
export function useCellRect(): CellRect | null {
  return useContext(CellContext);
}

export type GridProps = {
  cols: number;
  rows: number;
  /** Required at root; inherited automatically when nested inside a `<Cell>`. */
  width?: number;
  height?: number;
  /** Defaults to `GAP` (16) at root, and halves (`parent.gap / 2`) at each nested level. */
  gap?: number;
  /** Defaults to `gap` at root (shell padding == gap), and `0` when nested inside a cell. */
  padding?: number;
  /** Defaults to `RADIUS.shell` (44) at root, and `cell.radius` when nested. */
  radius?: number;
  /** Only needed on root grids; nested grids inherit pixelSize from their parent. */
  pixelSize?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  opacity?: number;
  pointerEventsType?: AllowedPointerEventsType;
  pointerEventsOrder?: number;
  /** Draws faint guide outlines over every 1×1 track in this grid. */
  showGuides?: boolean;
  children?: React.ReactNode;
};

export function Grid({
  cols,
  rows,
  width: widthProp,
  height: heightProp,
  gap: gapProp,
  padding: paddingProp,
  radius: radiusProp,
  pixelSize,
  backgroundColor,
  backgroundOpacity,
  opacity,
  pointerEventsType,
  pointerEventsOrder,
  showGuides = false,
  children,
}: GridProps) {
  const parentGrid = useContext(GridContext);
  const parentCell = useContext(CellContext);

  const depth = parentGrid ? parentGrid.depth + 1 : 0;
  const width = widthProp ?? parentCell?.width;
  const height = heightProp ?? parentCell?.height;
  if (width == null || height == null) {
    throw new Error("<Grid> requires explicit width and height when not nested inside a <Cell>");
  }

  const gap = gapProp ?? (parentGrid ? parentGrid.gap / 2 : GAP);
  const padding = paddingProp ?? (parentGrid ? 0 : gap);
  const radius = radiusProp ?? (parentCell ? parentCell.radius : RADIUS.shell);

  const metrics = useMemo(
    () => computeGridMetrics({ width, height, cols, rows, gap, padding, radius, depth }),
    [width, height, cols, rows, gap, padding, radius, depth],
  );

  const guides = useMemo(() => {
    if (!showGuides) return null;
    const rects: Array<{ key: string; rect: CellRect }> = [];
    for (let r = 0; r < metrics.rows; r++) {
      for (let c = 0; c < metrics.cols; c++) {
        rects.push({ key: `${c}-${r}`, rect: computeCellRect(metrics, c, r, 1, 1) });
      }
    }
    return rects;
  }, [showGuides, metrics]);

  const isRoot = parentGrid == null;
  const fill = backgroundColor ?? (isRoot ? COLOR.ground : COLOR.tile);
  const fillOpacity = backgroundOpacity ?? (isRoot ? 1 : 0);

  return (
    <GridContext.Provider value={metrics}>
      <Container
        pixelSize={pixelSize}
        pointerEventsType={pointerEventsType}
        pointerEventsOrder={pointerEventsOrder}
        opacity={opacity}
        width={metrics.outerWidth}
        height={metrics.outerHeight}
        borderRadius={clampRadius(metrics.radius, metrics.outerWidth, metrics.outerHeight)}
        backgroundColor={fill}
        backgroundOpacity={fillOpacity}
        positionType="relative"
      >
        {guides?.map(({ key, rect }) => (
          <Container
            key={`guide-${key}`}
            positionType="absolute"
            positionLeft={rect.x}
            positionTop={rect.y}
            width={rect.width}
            height={rect.height}
            borderRadius={rect.radius}
            backgroundOpacity={0}
            borderWidth={1}
            borderColor="#ffc300"
            opacity={0.35}
          />
        ))}
        {children}
      </Container>
    </GridContext.Provider>
  );
}

export type CellSurface = "none" | "tile" | "outline" | "accent" | "inverted" | "danger";

export type CellProps = {
  col: number;
  row: number;
  colSpan?: number;
  rowSpan?: number;
  /** "concentric" uses `parentRadius - inset`; "round" resolves to a full pill/circle. */
  shape?: "concentric" | "round";
  /** Visual surface role from the design system palette. */
  surface?: CellSurface;
  /** Interactive hover/active styling. */
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
  flexDirection?: "row" | "column";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  paddingX?: number;
  paddingY?: number;
  gap?: number;
  children?: React.ReactNode;
};

export function Cell({
  col,
  row,
  colSpan = 1,
  rowSpan = 1,
  shape = "concentric",
  surface = "none",
  active = false,
  disabled = false,
  onClick,
  onHover,
  flexDirection = "column",
  alignItems = "center",
  justifyContent = "center",
  paddingX,
  paddingY,
  gap,
  children,
}: CellProps) {
  const grid = useGridMetrics();
  const [hovered, setHovered] = useState(false);

  const rect = useMemo(
    () => computeCellRect(grid, col, row, colSpan, rowSpan, shape),
    [grid, col, row, colSpan, rowSpan, shape],
  );

  const interactive = !disabled && (onClick != null || onHover != null);

  let backgroundColor: string = COLOR.tile;
  let backgroundOpacity = 0;
  let borderWidth = 0;
  let borderColor: string = COLOR.outline;

  if (surface === "tile") {
    backgroundColor = active && !disabled
      ? COLOR.accent
      : hovered && interactive
      ? COLOR.tileHi
      : COLOR.tile;
    backgroundOpacity = 1;
  } else if (surface === "accent") {
    backgroundColor = hovered && interactive ? COLOR.accentBright : COLOR.accent;
    backgroundOpacity = disabled ? 0 : 1;
    if (disabled) {
      borderWidth = OUTLINE_WIDTH;
      borderColor = COLOR.inkDim;
    }
  } else if (surface === "inverted") {
    backgroundColor = COLOR.ink;
    backgroundOpacity = 1;
  } else if (surface === "danger") {
    backgroundColor = hovered && interactive ? COLOR.dangerBright : COLOR.danger;
    backgroundOpacity = disabled ? 0 : 1;
    if (disabled) {
      borderWidth = OUTLINE_WIDTH;
      borderColor = COLOR.inkDim;
    }
  } else if (surface === "outline") {
    if (active && !disabled) {
      backgroundColor = COLOR.accent;
      backgroundOpacity = 1;
    } else {
      backgroundOpacity = 0;
      borderWidth = OUTLINE_WIDTH;
      borderColor = disabled ? COLOR.inkDim : hovered && interactive ? COLOR.accent : COLOR.outline;
    }
  }

  return (
    <CellContext.Provider value={rect}>
      <Container
        positionType="absolute"
        positionLeft={rect.x}
        positionTop={rect.y}
        width={rect.width}
        height={rect.height}
        borderRadius={rect.radius}
        backgroundColor={backgroundColor}
        backgroundOpacity={backgroundOpacity}
        borderWidth={borderWidth}
        borderColor={borderColor}
        flexDirection={flexDirection}
        alignItems={alignItems}
        justifyContent={justifyContent}
        paddingX={paddingX}
        paddingY={paddingY}
        gap={gap}
        onPointerOver={interactive || onHover
          ? (event: unknown) => {
            setHovered(true);
            onHover?.(true);
            if (interactive) pulseForPointerEvent(event, "hover");
          }
          : undefined}
        onPointerOut={interactive || onHover
          ? () => {
            setHovered(false);
            onHover?.(false);
          }
          : undefined}
        onClick={!disabled && onClick
          ? (event: unknown) => {
            event && typeof (event as { stopPropagation?: () => void }).stopPropagation === "function" &&
              (event as { stopPropagation: () => void }).stopPropagation();
            pulseForPointerEvent(event, "click");
            onClick();
          }
          : undefined}
      >
        {children}
      </Container>
    </CellContext.Provider>
  );
}
