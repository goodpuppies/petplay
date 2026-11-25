/**
 * Reusable interactive controls built directly on the recursive `<Grid>` / `<Cell>` system.
 *
 * Every control fills 100% of its enclosing `<Cell>` by reading `useCellRect()`, so sizing,
 * spacing, and concentric corner radii are always inherited from the grid — never hardcoded.
 */
import React, { useRef, useState } from "react";
import * as THREE from "three";
import { Container } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import { Text } from "./text.tsx";
import { Cell, Grid, useCellRect } from "./grid.tsx";
import { COLOR, GAP, INNER_GAP } from "./tokens.ts";
import { pulseForPointerEvent } from "../haptics.ts";

const _sliderLocal = new THREE.Vector3();

/**
 * Compute normalized 0..1 slider position from a pointer event on a uikit Container.
 * Matches `@pmndrs/uikit-default` / `@pmndrs/uikit-horizon` Slider: a uikit Container's
 * `worldToLocal(point).x` is already normalized to `[-0.5, +0.5]` across its layout width.
 */
export function sliderFractionFromEvent(
  event: unknown,
  trackObj: THREE.Object3D | null | undefined,
): number | null {
  const e = event as {
    point?: THREE.Vector3;
    uv?: { x?: number };
    currentTarget?: THREE.Object3D;
  } | null;
  const host = trackObj ?? e?.currentTarget;
  if (e?.point && host && typeof host.worldToLocal === "function") {
    _sliderLocal.copy(e.point);
    host.worldToLocal(_sliderLocal);
    if (Number.isFinite(_sliderLocal.x)) {
      return Math.max(0, Math.min(1, _sliderLocal.x + 0.5));
    }
  }
  const uvX = e?.uv?.x;
  if (typeof uvX === "number" && Number.isFinite(uvX)) {
    return Math.max(0, Math.min(1, uvX));
  }
  return null;
}

/**
 * Horizontal slider bar filling its enclosing `<Cell>` (click or drag anywhere along the track).
 * Uses the same progress-fill visual language as the battery bars.
 */
export function GridSlider({
  label,
  value,
  min,
  max,
  step = 0.05,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue: (value: number) => string;
  onChange: (next: number) => void;
}) {
  const rect = useCellRect();
  const trackRef = useRef<THREE.Object3D | null>(null);
  const draggingPointerId = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  if (!rect) return null;

  const { width, height, radius: r } = rect;
  const fraction = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const fillW = Math.round(width * fraction);
  const leftR = Math.min(r, height / 2, fillW / 2);
  const rightRem = width - fillW;
  const rightR = rightRem < r ? Math.min(r - rightRem, height / 2, fillW / 2) : 0;
  const compact = height < 58;

  const updateFromEvent = (event: unknown, hapticOnStep: boolean) => {
    const t = sliderFractionFromEvent(event, trackRef.current);
    if (t == null) return;
    const raw = min + t * (max - min);
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.max(min, Math.min(max, Math.round(snapped * 1000) / 1000));
    if (Math.abs(clamped - value) > 1e-4) {
      if (hapticOnStep) pulseForPointerEvent(event, "hover");
      onChange(clamped);
    }
    (event as { stopPropagation?: () => void } | null)?.stopPropagation?.();
  };

  const endDrag = (event: unknown) => {
    const e = event as {
      pointerId?: number;
      currentTarget?: { releasePointerCapture?: (id: number) => void };
      target?: { releasePointerCapture?: (id: number) => void };
    } | null;
    if (
      draggingPointerId.current != null &&
      typeof e?.pointerId === "number" &&
      e.pointerId !== draggingPointerId.current
    ) {
      return;
    }
    const id = draggingPointerId.current;
    draggingPointerId.current = null;
    if (id != null && id >= 0) {
      (e?.currentTarget ?? e?.target)?.releasePointerCapture?.(id);
    }
  };

  return (
    <Container
      ref={trackRef}
      width={width}
      height={height}
      borderRadius={r}
      backgroundColor={hovered ? "#1c1e26" : "#141418"}
      backgroundOpacity={1}
      positionType="relative"
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      paddingX={GAP}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      onPointerDown={(event: unknown) => {
        const e = event as {
          pointerId?: number;
          pointerType?: string;
          button?: number;
          currentTarget?: { setPointerCapture?: (id: number) => void };
          target?: { setPointerCapture?: (id: number) => void };
        };
        if (e.pointerType === "grab") return;
        if (typeof e.button === "number" && e.button !== 0) return;
        const id = typeof e.pointerId === "number" ? e.pointerId : -1;
        draggingPointerId.current = id;
        if (id >= 0) (e.currentTarget ?? e.target)?.setPointerCapture?.(id);
        pulseForPointerEvent(event, "click");
        updateFromEvent(event, false);
      }}
      onPointerMove={(event: unknown) => {
        if (draggingPointerId.current == null) return;
        const e = event as {
          pointerId?: number;
          buttons?: number;
          pointerType?: string;
        };
        if (typeof e.pointerId === "number" && e.pointerId !== draggingPointerId.current) return;
        // If no button is held (e.g. pointerup was missed when opening/closing the panel),
        // stop dragging immediately so plain hover never moves the slider.
        if (typeof e.buttons === "number" && e.buttons === 0 && e.pointerType !== "poker") {
          draggingPointerId.current = null;
          return;
        }
        updateFromEvent(event, true);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={(event: unknown) => {
        const e = event as {
          pointerId?: number;
          currentTarget?: { hasPointerCapture?: (id: number) => boolean };
          target?: { hasPointerCapture?: (id: number) => boolean };
        };
        const id = draggingPointerId.current;
        if (id == null) return;
        if (typeof e.pointerId === "number" && e.pointerId !== id) return;
        if (id < 0 || !(e.currentTarget ?? e.target)?.hasPointerCapture?.(id)) {
          draggingPointerId.current = null;
        }
      }}
    >
      {fillW > 0 && (
        <Container
          pointerEvents="none"
          positionType="absolute"
          positionLeft={0}
          positionTop={0}
          width={fillW}
          height={height}
          borderTopLeftRadius={leftR}
          borderBottomLeftRadius={leftR}
          borderTopRightRadius={rightR}
          borderBottomRightRadius={rightR}
          backgroundColor="#4a4d5c"
          backgroundOpacity={1}
        />
      )}
      <Container pointerEvents="none">
        <Text color={COLOR.ink} fontSize={compact ? 18 : 22}>{label}</Text>
      </Container>
      <Container pointerEvents="none">
        <Text color={COLOR.accent} fontSize={compact ? 20 : 24}>{formatValue(value)}</Text>
      </Container>
    </Container>
  );
}

/**
 * Interactive boolean toggle filling its enclosing `<Cell>`.
 * Clicking anywhere on the cell flips the value.
 */
export function GridToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const rect = useCellRect();
  const [hovered, setHovered] = useState(false);
  if (!rect) return null;

  const compact = rect.height < 58 || rect.width < 280;
  const pillH = Math.min(32, Math.max(24, rect.height - 12));

  return (
    <Container
      width={rect.width}
      height={rect.height}
      borderRadius={rect.radius}
      paddingX={compact ? 14 : GAP}
      backgroundColor={hovered ? "#1e2028" : COLOR.ground}
      backgroundOpacity={1}
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      onPointerOver={(event: unknown) => {
        setHovered(true);
        pulseForPointerEvent(event, "hover");
      }}
      onPointerOut={() => setHovered(false)}
      onClick={(event: unknown) => {
        pulseForPointerEvent(event, "click");
        onChange(!value);
      }}
    >
      <Text color={COLOR.ink} fontSize={compact ? 15 : 18}>{label}</Text>
      <Container
        width={compact ? 52 : 68}
        height={pillH}
        borderRadius={pillH / 2}
        alignItems="center"
        justifyContent="center"
        backgroundColor={value ? COLOR.accent : COLOR.tile}
        backgroundOpacity={1}
      >
        <Text color={value ? COLOR.onAccent : COLOR.inkDim} fontSize={compact ? 13 : 15}>
          {value ? "ON" : "OFF"}
        </Text>
      </Container>
    </Container>
  );
}

/**
 * Labeled option picker filling a 4×1 (or any wide) `<Cell>` via a nested recursive `<Grid>`:
 * title on top, equal-width selectable option cells across the bottom.
 */
export function GridOptionSection<T extends string>({
  label,
  options,
  value,
  onChange,
  showGuides = false,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (next: T) => void;
  showGuides?: boolean;
}) {
  const cols = Math.max(1, options.length);
  return (
    <Grid cols={1} rows={2} gap={INNER_GAP} padding={INNER_GAP} showGuides={showGuides}>
      <Cell col={0} row={0} flexDirection="row" justifyContent="flex-start" paddingX={12}>
        <Text color={COLOR.inkDim} fontSize={18}>{label}</Text>
      </Cell>
      <Cell col={0} row={1}>
        <Grid cols={cols} rows={1} gap={INNER_GAP} padding={0} showGuides={showGuides}>
          {options.map((opt, idx) => {
            const selected = opt.value === value;
            return (
              <Cell
                key={opt.value}
                col={idx}
                row={0}
                shape="round"
                surface={selected ? "accent" : "outline"}
                onClick={() => onChange(opt.value)}
              >
                <Text color={selected ? COLOR.onAccent : COLOR.ink} fontSize={cols >= 4 ? 15 : 18}>
                  {opt.label}
                </Text>
              </Cell>
            );
          })}
        </Grid>
      </Cell>
    </Grid>
  );
}
