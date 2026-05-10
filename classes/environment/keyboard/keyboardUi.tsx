import React, { forwardRef, useCallback, useEffect, useMemo, useState } from "react";
// @deno-types="@types/three/webgpu"
import type * as THREE from "three/webgpu";
import { Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import type { EventHandlersProperties } from "../../../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/events.ts";
import type {
  KeyboardLayoutJson,
  KeyboardLayoutMode,
  KeyboardLogicEvent,
  KeyboardSink,
  LayoutFormat,
  ModifierSnapshot,
} from "./types.ts";
import { keyTextColor, tokenBackground, tokenBorderColor } from "./theme.ts";
import {
  getMainGroupRows,
  isModifierLatchedVisual,
  resolveLabel,
  type RowItem,
} from "./keyboardLayout.ts";
import { stripJsonComments } from "./parseJsonComments.ts";
import { InteractiveKeyCap } from "./keyboardKeyInteraction.tsx";
import { scanCodeHexToNumber, usQwertyFromScan } from "./usLayout.ts";

const DEFAULT_ROW_HEIGHT = 64;

/**
 * Uikit `Container` defaults can resolve to a visible (often white) instanced panel for “empty” flex
 * chrome. Use for stack/row/gutter shells that should only hit-test and not draw.
 * Do not set `backgroundOpacity={0}` here — the webgpu `Container` maps that to the whole element opacity.
 */
const LAYOUT_CHROME: { backgroundColor: "transparent"; borderWidth: 0 } = {
  backgroundColor: "transparent",
  borderWidth: 0,
};

export const DEFAULT_KEYBOARD_JSON_URL = new URL(
  "../../../resources/Keyboard.json",
  import.meta.url,
);
export const DEFAULT_KEYBOARD_PIXEL_SIZE = 0.00095;
/** Tray behind key groups — lighter than a pure dark panel for AMOLED legibility. */
export const DEFAULT_KEYBOARD_COLUMN_BACKGROUND = "#2c3540";

const initialMods: ModifierSnapshot = {
  shift: false,
  caps: false,
  leftCtrl: false,
  rightCtrl: false,
  leftAlt: false,
  rightAlt: false,
  leftMeta: false,
  rightMeta: false,
};

export type KeyCapChromeProps =
  & {
    face: NormalizedKeyFace;
    /** Yoga layout: inner pixel units. */
    minWidth: number;
    minHeight: number;
    keyPadding?: number;
    pixelSize: number;
    children?: React.ReactNode;
    pressedVisual?: boolean;
    /** uikit local Z (meters × pixelSize); negative = depress into board. */
    transformTranslateZ?: number;
    transformScaleX?: number;
    transformScaleY?: number;
    visualRef?: React.Ref<unknown>;
  }
  & Pick<
    EventHandlersProperties,
    "onPointerDown" | "onPointerUp" | "onPointerOut" | "onClick" | "onPointerOver"
  >;

/**
 * Visual-only key cap: colors and typography shell (no pointer handlers).
 */
export function KeyCapChrome(
  {
    face,
    minWidth,
    minHeight,
    pixelSize,
    children,
    pressedVisual = false,
    transformTranslateZ,
    transformScaleX,
    transformScaleY,
    visualRef,
    ...events
  }: KeyCapChromeProps,
) {
  const fill = tokenBackground(face.colorToken, pressedVisual);
  const borderC = tokenBorderColor(face.colorToken, pressedVisual);
  const tc = keyTextColor(face.colorToken, pressedVisual);

  return (
    <Container
      pixelSize={pixelSize}
      minWidth={minWidth}
      minHeight={minHeight}
      alignItems="center"
      justifyContent="center"
      {...LAYOUT_CHROME}
      {...events}
    >
      <Container
        ref={visualRef}
        pixelSize={pixelSize}
        minWidth={minWidth}
        minHeight={minHeight}
        backgroundColor={fill}
        backgroundOpacity={1}
        borderWidth={pressedVisual ? 2 : 1}
        borderColor={borderC}
        borderRadius={5}
        padding={4}
        alignItems="center"
        justifyContent="center"
        pointerEvents="none"
        transformTranslateZ={transformTranslateZ}
        transformScaleX={transformScaleX}
        transformScaleY={transformScaleY}
      >
        {children ?? (
          <Text color={tc} fontSize={face.fontSize} pixelSize={pixelSize} textAlign="center">
            {"·"}
          </Text>
        )}
      </Container>
    </Container>
  );
}

export type KeyboardRowViewProps = {
  faces: (NormalizedKeyFace | { spacer: true; width: number; height: number })[];
  keyWidth: number;
  keyPadding: number;
  keyRowHeight: number;
  pixelSize: number;
  renderKey: (face: NormalizedKeyFace) => React.ReactNode;
  renderSpacer: (width: number, height: number) => React.ReactNode;
};

export function KeyboardRowView(
  { faces, keyWidth, keyPadding, keyRowHeight: _rowH, pixelSize, renderKey, renderSpacer }:
    KeyboardRowViewProps,
) {
  // Avoid flex `gapColumn` — in this uikit build it can allocate visible (often white) gap panels.
  const rowChildren: React.ReactNode[] = [];
  for (let i = 0; i < faces.length; i++) {
    if (i > 0) {
      rowChildren.push(
        <Container
          key={`h-gap-${i}`}
          pixelSize={pixelSize}
          minWidth={keyPadding}
          minHeight={1}
          alignSelf="stretch"
          {...LAYOUT_CHROME}
        />,
      );
    }
    const cell = faces[i]!;
    if ("spacer" in cell && cell.spacer) {
      rowChildren.push(
        <React.Fragment key={`s-${i}`}>{renderSpacer(cell.width, cell.height)}</React.Fragment>,
      );
    } else {
      const face = cell as NormalizedKeyFace;
      rowChildren.push(
        <React.Fragment key={face.id}>{renderKey(face)}</React.Fragment>,
      );
    }
  }
  return (
    <Container
      pixelSize={pixelSize}
      flexDirection="row"
      alignItems="stretch"
      {...LAYOUT_CHROME}
    >
      {rowChildren}
    </Container>
  );
}

export type KeyboardColumnShellProps = {
  pixelSize?: number;
  keyPadding: number;
  keyGroupsPadding: number;
  background?: string;
  children?: React.ReactNode;
};

/**
 * Bordered column stack for one keyboard region (main, nav, or numpad).
 */
export function KeyboardColumnShell(
  {
    pixelSize = DEFAULT_KEYBOARD_PIXEL_SIZE,
    keyPadding,
    keyGroupsPadding,
    background = DEFAULT_KEYBOARD_COLUMN_BACKGROUND,
    children,
  }: KeyboardColumnShellProps,
) {
  return (
    <Container
      pixelSize={pixelSize}
      backgroundColor={background}
      backgroundOpacity={0.97}
      borderColor="#3d4d5c"
      borderWidth={1}
      borderRadius={10}
      padding={keyGroupsPadding + 2}
      flexDirection="column"
    >
      {children}
    </Container>
  );
}

export type KeyboardFromJsonProps = {
  /** Defaults to [resources/Keyboard.json](c:/GIT/petplay/resources/Keyboard.json) when not using `preloadedLayout`. */
  layoutUrl?: URL;
  /**
   * When set (e.g. by [KeyboardPanel](keyboard/keyboard.tsx)), the layout is not read from disk
   * a second time.
   */
  preloadedLayout?: KeyboardLayoutJson | null;
  onKey?: KeyboardSink;
  layoutFormat?: LayoutFormat;
  columnBackground?: string;
  /** Uikit `pixelSize` for flex layout. */
  pixelSize?: number;
  /** `compact` = main only (default); `full` = nav + numpad. */
  layoutMode?: KeyboardLayoutMode;
};

export const DEFAULT_KEYBOARD_LAYOUT_MODE: KeyboardLayoutMode = "compact";

/**
 * Load `Keyboard.json`, parse rows (ansi / iso / jis + nav + numpad), and render the uikit keyboard with modifier handling.
 * All props optional — defaults match the plan’s prototype data path and styling.
 * `ref` → root uikit [Container] (default center anchor).
 */
export const KeyboardFromJson = forwardRef<THREE.Object3D, KeyboardFromJsonProps>(
  function KeyboardFromJson(
    {
      layoutUrl = DEFAULT_KEYBOARD_JSON_URL,
      preloadedLayout = null,
      onKey,
      layoutFormat = "ansi",
      columnBackground = DEFAULT_KEYBOARD_COLUMN_BACKGROUND,
      pixelSize = DEFAULT_KEYBOARD_PIXEL_SIZE,
      layoutMode = DEFAULT_KEYBOARD_LAYOUT_MODE,
    },
    ref,
  ) {
    const [raw, setRaw] = useState<KeyboardLayoutJson | null>(() => preloadedLayout);
    const [mods, setMods] = useState<ModifierSnapshot>(initialMods);

    const path = useMemo(() => layoutUrl, [layoutUrl]);

    useEffect(() => {
      if (preloadedLayout) {
        setRaw(preloadedLayout);
        return;
      }
      let cancel = false;
      void (async () => {
        const text = await Deno.readTextFile(path);
        if (cancel) {
          return;
        }
        setRaw(JSON.parse(stripJsonComments(text)) as KeyboardLayoutJson);
      })();
      return () => {
        cancel = true;
      };
    }, [path, preloadedLayout]);

    const sink: KeyboardSink = onKey ?? ((ev) => {
      console.log("[keyboard]", ev);
    });

    const emit = useCallback(
      (ev: KeyboardLogicEvent) => {
        sink(ev);
      },
      [sink],
    );

    const handleKey = useCallback(
      (face: NormalizedKeyFace) => {
        if (face.useVirtualKeyCode) {
          const s = face.displayMain;
          emit({
            kind: "key",
            scanCode: 0,
            scanCodeHex: "00",
            char: s.length === 1 ? s : undefined,
            virtualKeyName: face.virtualName,
          });
          return;
        }
        const hi = face.scanCodeHex.toUpperCase();
        const sc = scanCodeHexToNumber(hi);
        if (face.toggle && hi === "3A") {
          setMods((m) => {
            const next = { ...m, caps: !m.caps };
            emit({ kind: "modifier", modifier: "caps", active: next.caps });
            return next;
          });
          return;
        }
        if (face.sticky) {
          if (hi === "2A" || hi === "36") {
            setMods((m) => {
              const next = { ...m, shift: !m.shift };
              emit({ kind: "modifier", modifier: "shift", active: next.shift });
              return next;
            });
            return;
          }
          if (hi === "1D") {
            setMods((m) => {
              const next = { ...m, leftCtrl: !m.leftCtrl };
              emit({ kind: "modifier", modifier: "leftCtrl", active: next.leftCtrl });
              return next;
            });
            return;
          }
          if (hi === "E01D") {
            setMods((m) => {
              const next = { ...m, rightCtrl: !m.rightCtrl };
              emit({ kind: "modifier", modifier: "rightCtrl", active: next.rightCtrl });
              return next;
            });
            return;
          }
          if (hi === "38") {
            setMods((m) => {
              const next = { ...m, leftAlt: !m.leftAlt };
              emit({ kind: "modifier", modifier: "leftAlt", active: next.leftAlt });
              return next;
            });
            return;
          }
          if (hi === "E038") {
            setMods((m) => {
              const next = { ...m, rightAlt: !m.rightAlt };
              emit({ kind: "modifier", modifier: "rightAlt", active: next.rightAlt });
              return next;
            });
            return;
          }
          if (hi === "E05B") {
            setMods((m) => {
              const next = { ...m, leftMeta: !m.leftMeta };
              emit({ kind: "modifier", modifier: "leftMeta", active: next.leftMeta });
              return next;
            });
            return;
          }
          if (hi === "E05C") {
            setMods((m) => {
              const next = { ...m, rightMeta: !m.rightMeta };
              emit({ kind: "modifier", modifier: "rightMeta", active: next.rightMeta });
              return next;
            });
            return;
          }
        }
        const { main } = usQwertyFromScan(
          face.scanCodeHex,
          { shift: mods.shift, caps: mods.caps },
          face.respectCapsLock,
        );
        emit({
          kind: "key",
          scanCode: sc,
          scanCodeHex: hi,
          char: main.length === 1 ? main : undefined,
        });
      },
      [emit, mods],
    );

    if (raw == null) {
      return null;
    }

    const { keyWidth, keyPadding, keyGroupsPadding, mainRows, navRows, numpadRows, rowH } =
      getMainGroupRows(
        raw,
        layoutFormat,
      );

    const makeColumn = (rows: RowItem[][], columnId: string) => {
      // Avoid flex `gap` in the column: same “white gap quads” issue as `gapColumn` on rows.
      const colChildren: React.ReactNode[] = rows.flatMap((r, i) => {
        const rowView = (
          <KeyboardRowView
            key={`${columnId}-row-${i}`}
            faces={r}
            keyWidth={keyWidth}
            keyPadding={keyPadding}
            keyRowHeight={rowH}
            pixelSize={pixelSize}
            renderKey={(face) => (
              <InteractiveKeyCap
                key={face.id}
                face={face}
                minWidth={keyWidth * face.widthMul}
                minHeight={rowH * face.heightMul}
                pixelSize={pixelSize}
                currentLabel={resolveLabel(face, mods)}
                latched={isModifierLatchedVisual(face, mods)}
                onActivate={handleKey}
              />
            )}
            renderSpacer={(sw, sh) => (
              <Container
                minWidth={keyWidth * sw}
                minHeight={rowH * sh}
                {...LAYOUT_CHROME}
              />
            )}
          />
        );
        if (i === 0) {
          return [rowView];
        }
        return [
          <Container
            key={`${columnId}-v-gap-${i}`}
            pixelSize={pixelSize}
            minHeight={keyPadding}
            minWidth={1}
            alignSelf="stretch"
            {...LAYOUT_CHROME}
          />,
          rowView,
        ];
      });
      return (
        <KeyboardColumnShell
          key={columnId}
          pixelSize={pixelSize}
          keyPadding={keyPadding}
          keyGroupsPadding={0}
          background={columnBackground}
        >
          {colChildren}
        </KeyboardColumnShell>
      );
    };

    const packH = 2 * (keyGroupsPadding + 2);
    const colH = (rows: number) => rows * rowH + Math.max(0, rows - 1) * keyPadding + packH;
    const columnBlockH = Math.max(
      colH(mainRows.length),
      colH(navRows.length),
      colH(numpadRows.length),
    );
    if (layoutMode === "compact") {
      return (
        <Container
          ref={ref}
          pixelSize={pixelSize}
          flexDirection="row"
          alignItems="flex-start"
          gap={0}
          {...LAYOUT_CHROME}
        >
          {makeColumn(mainRows, "main")}
        </Container>
      );
    }

    return (
      <Container
        ref={ref}
        pixelSize={pixelSize}
        flexDirection="row"
        alignItems="flex-start"
        gap={0}
        {...LAYOUT_CHROME}
      >
        {makeColumn(mainRows, "main")}
        <Container
          pixelSize={pixelSize}
          minWidth={keyGroupsPadding}
          minHeight={columnBlockH}
          {...LAYOUT_CHROME}
        />
        {makeColumn(navRows, "nav")}
        <Container
          pixelSize={pixelSize}
          minWidth={keyGroupsPadding}
          minHeight={columnBlockH}
          {...LAYOUT_CHROME}
        />
        {makeColumn(numpadRows, "numpad")}
      </Container>
    );
  },
);

export { DEFAULT_ROW_HEIGHT };

/** @deprecated Use `KeyboardColumnShell`. */
export const KeyboardPanelChrome = KeyboardColumnShell;
/** @deprecated Use `KeyboardColumnShellProps`. */
export type KeyboardPanelChromeProps = KeyboardColumnShellProps;
