import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import type { EventHandlersProperties } from "../../../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/events.ts";
import type {
  KeyboardLayoutJson,
  KeyboardLogicEvent,
  KeyboardSink,
  LayoutFormat,
  ModifierSnapshot,
} from "./types.ts";
import { keyTextColor, tokenBackground, tokenBorderColor } from "./theme.ts";
import { getMainGroupRows, resolveLabel, type RowItem } from "./keyboardLayout.ts";
import { stripJsonComments } from "./parseJsonComments.ts";
import { InteractiveKeyCap } from "./keyboardKeyInteraction.tsx";
import { scanCodeHexToNumber, usQwertyFromScan } from "./usLayout.ts";

const DEFAULT_ROW_HEIGHT = 64;

export const DEFAULT_KEYBOARD_JSON_URL = new URL("../../../resources/Keyboard.json", import.meta.url);
export const DEFAULT_KEYBOARD_PIXEL_SIZE = 0.00095;
export const DEFAULT_KEYBOARD_COLUMN_BACKGROUND = "#0e141c";

const initialMods: ModifierSnapshot = {
  shift: false,
  caps: false,
  leftCtrl: false,
  rightCtrl: false,
  leftAlt: false,
  rightAlt: false,
};

export type KeyCapChromeProps = {
  face: NormalizedKeyFace;
  /** Yoga layout: inner pixel units. */
  minWidth: number;
  minHeight: number;
  keyPadding?: number;
  pixelSize: number;
  children?: React.ReactNode;
  pressedVisual?: boolean;
} & Pick<
  EventHandlersProperties,
  "onPointerDown" | "onPointerUp" | "onPointerOut" | "onClick" | "onPointerOver"
>;

/**
 * Visual-only key cap: colors and typography shell (no pointer handlers).
 */
export function KeyCapChrome(
  { face, minWidth, minHeight, pixelSize, children, pressedVisual = false, ...events }: KeyCapChromeProps,
) {
  const fill = tokenBackground(face.colorToken);
  const borderC = tokenBorderColor(face.colorToken);
  const tc = keyTextColor(face.colorToken);
  const baseOpacity = pressedVisual ? 0.72 : 0.95;

  return (
    <Container
      pixelSize={pixelSize}
      minWidth={minWidth}
      minHeight={minHeight}
      backgroundColor={fill}
      backgroundOpacity={baseOpacity}
      borderWidth={1}
      borderColor={borderC}
      borderRadius={6}
      padding={4}
      alignItems="center"
      justifyContent="center"
      {...events}
    >
      {children ?? (
        <Text color={tc} fontSize={face.fontSize} pixelSize={pixelSize} textAlign="center">
          {"·"}
        </Text>
      )}
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
  { faces, keyWidth, keyPadding, keyRowHeight, pixelSize, renderKey, renderSpacer }: KeyboardRowViewProps,
) {
  return (
    <Container
      pixelSize={pixelSize}
      flexDirection="row"
      alignItems="stretch"
      gapColumn={keyPadding}
    >
      {faces.map((cell, i) => {
        if ("spacer" in cell && cell.spacer) {
          return <React.Fragment key={`s-${i}`}>{renderSpacer(cell.width, cell.height)}</React.Fragment>;
        }
        return <React.Fragment key={(cell as NormalizedKeyFace).id}>{renderKey(cell as NormalizedKeyFace)}</React.Fragment>;
      })}
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
      backgroundOpacity={0.88}
      borderColor="#1f2a35"
      borderWidth={2}
      borderRadius={12}
      padding={keyGroupsPadding + 2}
      flexDirection="column"
      gap={keyPadding}
    >
      {children}
    </Container>
  );
}

export type KeyboardFromJsonProps = {
  /** Defaults to [resources/Keyboard.json](c:/GIT/petplay/resources/Keyboard.json). */
  layoutUrl?: URL;
  onKey?: KeyboardSink;
  layoutFormat?: LayoutFormat;
  columnBackground?: string;
  /** Uikit `pixelSize` for flex layout. */
  pixelSize?: number;
};

/**
 * Load `Keyboard.json`, parse rows (ansi / iso / jis + nav + numpad), and render the full uikit keyboard with modifier handling.
 * All props optional — defaults match the plan’s prototype data path and styling.
 */
export function KeyboardFromJson(
  {
    layoutUrl = DEFAULT_KEYBOARD_JSON_URL,
    onKey,
    layoutFormat = "ansi",
    columnBackground = DEFAULT_KEYBOARD_COLUMN_BACKGROUND,
    pixelSize = DEFAULT_KEYBOARD_PIXEL_SIZE,
  }: KeyboardFromJsonProps = {},
) {
  const [raw, setRaw] = useState<KeyboardLayoutJson | null>(null);
  const [mods, setMods] = useState<ModifierSnapshot>(initialMods);

  const path = useMemo(() => layoutUrl, [layoutUrl]);

  useEffect(() => {
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
  }, [path]);

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
        emit({ kind: "key", scanCode: 0, char: s.length === 1 ? s : undefined });
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
      if (face.sticky && (hi === "2A" || hi === "36")) {
        setMods((m) => {
          const next = { ...m, shift: !m.shift };
          emit({ kind: "modifier", modifier: "shift", active: next.shift });
          return next;
        });
        return;
      }
      const { main } = usQwertyFromScan(
        face.scanCodeHex,
        { shift: mods.shift, caps: mods.caps },
        face.respectCapsLock,
      );
      emit({
        kind: "key",
        scanCode: sc,
        char: main.length === 1 ? main : undefined,
      });
    },
    [emit, mods.caps, mods.shift],
  );

  if (raw == null) {
    return null;
  }

  const { keyWidth, keyPadding, keyGroupsPadding, mainRows, navRows, numpadRows, rowH } = getMainGroupRows(
    raw,
    layoutFormat,
  );

  const makeColumn = (rows: RowItem[][], columnId: string) => (
    <KeyboardColumnShell
      key={columnId}
      pixelSize={pixelSize}
      keyPadding={keyPadding}
      keyGroupsPadding={0}
      background={columnBackground}
    >
      {rows.map((r, i) => (
        <KeyboardRowView
          key={`${columnId}-${i}`}
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
              onActivate={handleKey}
            />
          )}
          renderSpacer={(sw, sh) => (
            <Container
              minWidth={keyWidth * sw}
              minHeight={rowH * sh}
            />
          )}
        />
      ))}
    </KeyboardColumnShell>
  );

  return (
    <Container
      pixelSize={pixelSize}
      flexDirection="row"
      alignItems="flex-start"
      gap={keyGroupsPadding}
    >
      {makeColumn(mainRows, "main")}
      {makeColumn(navRows, "nav")}
      {makeColumn(numpadRows, "numpad")}
    </Container>
  );
}

export { DEFAULT_ROW_HEIGHT };

/** @deprecated Use `KeyboardColumnShell`. */
export const KeyboardPanelChrome = KeyboardColumnShell;
/** @deprecated Use `KeyboardColumnShellProps`. */
export type KeyboardPanelChromeProps = KeyboardColumnShellProps;
