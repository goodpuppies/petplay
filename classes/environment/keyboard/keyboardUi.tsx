import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useThree } from "@react-three/fiber/webgpu";
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

export const KEYCAP_FRONT_RENDER_ORDER = 20000;
export const KEYCAP_FRONT_RENDER_PROPS = {
  depthTest: false,
  depthWrite: false,
  renderOrder: KEYCAP_FRONT_RENDER_ORDER,
} as const;
const POKER_KEY_HIT_DEPTH = 0.05;
const POKER_KEY_HIT_FRONT_Z = -0.012;
const POKER_KEY_PRESS_SPHERE_Z = -0.028;
const POKER_KEY_PRESS_SPHERE_MIN_RADIUS = 0.018;
const POKER_KEY_PRESS_SPHERE_RADIUS_FACTOR = 0.36;
const POKER_KEY_PRESS_OVERLAP = 0.004;
const POKER_KEY_PRESS_DWELL_MS = 35;
const POKER_KEY_PRESS_INWARD_VELOCITY = -0.018;
const POKER_DEBUG_KEY_SCAN_CODE = "23";
const POKER_DEBUG_RENDER_ORDER = 31000;

type PokerKeyDebugVisuals = {
  group: THREE.Group;
  boxHelper: THREE.Box3Helper;
  frontPlane: THREE.Mesh;
  backPlane: THREE.Mesh;
  pressSphere: THREE.Mesh;
  sphere: THREE.Mesh;
  centerDot: THREE.Mesh;
  closestDot: THREE.Mesh;
  line: THREE.Line;
  linePosition: THREE.BufferAttribute;
  statusMaterial: THREE.MeshBasicMaterial;
};

function keyHasPokerDebug(face: NormalizedKeyFace): boolean {
  return face.scanCodeHex.toUpperCase() === POKER_DEBUG_KEY_SCAN_CODE;
}

function setDebugMaterialState(
  material: THREE.MeshBasicMaterial,
  pressReady: boolean,
  overlapping: boolean,
): void {
  material.color.setHex(
    pressReady ? 0x00ff66 : overlapping ? 0xffcc00 : 0xff3355,
  );
  material.opacity = pressReady ? 0.55 : 0.35;
}

function createPokerKeyDebugVisuals(
  box: THREE.Box3,
  halfWidth: number,
  halfHeight: number,
  pressSphereRadius: number,
): PokerKeyDebugVisuals {
  const group = new THREE.Group();
  group.name = "H-key poker debug";
  group.renderOrder = POKER_DEBUG_RENDER_ORDER;
  group.userData.raythreeHudOverUi = true;

  const boxHelper = new THREE.Box3Helper(box, 0x00d1ff);
  boxHelper.renderOrder = POKER_DEBUG_RENDER_ORDER;
  const boxHelperMaterial = boxHelper.material as THREE.LineBasicMaterial;
  boxHelperMaterial.depthTest = false;
  boxHelperMaterial.depthWrite = false;
  group.add(boxHelper);

  const planeGeometry = new THREE.PlaneGeometry(halfWidth * 2, halfHeight * 2);
  const frontPlane = new THREE.Mesh(
    planeGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.16,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  frontPlane.position.z = box.max.z;
  frontPlane.renderOrder = POKER_DEBUG_RENDER_ORDER;
  group.add(frontPlane);

  const backPlane = new THREE.Mesh(
    planeGeometry.clone(),
    new THREE.MeshBasicMaterial({
      color: 0xff3355,
      transparent: true,
      opacity: 0.12,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  backPlane.position.z = box.min.z;
  backPlane.renderOrder = POKER_DEBUG_RENDER_ORDER;
  group.add(backPlane);

  const pressSphere = new THREE.Mesh(
    new THREE.SphereGeometry(pressSphereRadius, 20, 10),
    new THREE.MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.18,
      depthTest: false,
      depthWrite: false,
      wireframe: true,
    }),
  );
  pressSphere.position.z = POKER_KEY_PRESS_SPHERE_Z;
  pressSphere.renderOrder = POKER_DEBUG_RENDER_ORDER;
  group.add(pressSphere);

  const statusMaterial = new THREE.MeshBasicMaterial({
    color: 0xff3355,
    transparent: true,
    opacity: 0.35,
    depthTest: false,
    depthWrite: false,
    wireframe: true,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), statusMaterial);
  sphere.renderOrder = POKER_DEBUG_RENDER_ORDER;
  sphere.visible = false;
  group.add(sphere);

  const centerDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 8, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
    }),
  );
  centerDot.renderOrder = POKER_DEBUG_RENDER_ORDER;
  centerDot.visible = false;
  group.add(centerDot);

  const closestDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 8, 6),
    new THREE.MeshBasicMaterial({
      color: 0x00d1ff,
      depthTest: false,
      depthWrite: false,
    }),
  );
  closestDot.renderOrder = POKER_DEBUG_RENDER_ORDER;
  closestDot.visible = false;
  group.add(closestDot);

  const lineGeometry = new THREE.BufferGeometry();
  const linePosition = new THREE.BufferAttribute(new Float32Array(6), 3);
  lineGeometry.setAttribute("position", linePosition);
  const line = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    }),
  );
  line.renderOrder = POKER_DEBUG_RENDER_ORDER;
  line.visible = false;
  group.add(line);

  return {
    group,
    boxHelper,
    frontPlane,
    backPlane,
    pressSphere,
    sphere,
    centerDot,
    closestDot,
    line,
    linePosition,
    statusMaterial,
  };
}

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
  const scene = useThree((state) => state.scene);
  const outerRef = useRef<
    THREE.Object3D & {
      spherecast?: (sphere: THREE.Sphere, intersects: THREE.Intersection[]) => void;
    } | null
  >(null);

  useEffect(() => {
    const object = outerRef.current;
    if (object == null) return;
    const halfWidth = 0.5 * minWidth * pixelSize;
    const halfHeight = 0.5 * minHeight * pixelSize;
    const pressBackZ = POKER_KEY_HIT_FRONT_Z - POKER_KEY_HIT_DEPTH;
    const pressSphereRadius = Math.max(
      POKER_KEY_PRESS_SPHERE_MIN_RADIUS,
      Math.min(halfWidth, halfHeight) * POKER_KEY_PRESS_SPHERE_RADIUS_FACTOR,
    );
    const pressSphereCenter = new THREE.Vector3(0, 0, POKER_KEY_PRESS_SPHERE_Z);
    const box = new THREE.Box3(
      new THREE.Vector3(-halfWidth, -halfHeight, pressBackZ),
      new THREE.Vector3(halfWidth, halfHeight, POKER_KEY_HIT_FRONT_Z),
    );
    const debugVisuals = keyHasPokerDebug(face)
      ? createPokerKeyDebugVisuals(box, halfWidth, halfHeight, pressSphereRadius)
      : null;
    if (debugVisuals != null) {
      debugVisuals.group.matrixAutoUpdate = false;
      scene.add(debugVisuals.group);
    }
    const inverse = new THREE.Matrix4();
    const localCenter = new THREE.Vector3();
    const closestLocal = new THREE.Vector3();
    const closestWorld = new THREE.Vector3();
    const worldScale = new THREE.Vector3();
    const previousLocalCenter = new THREE.Vector3();
    let hasPreviousLocalCenter = false;
    let previousTimestamp = 0;
    let overlapStartedAt = 0;
    object.spherecast = (sphere, intersects) => {
      const now = performance.now();
      object.updateWorldMatrix(true, false);
      inverse.copy(object.matrixWorld).invert();
      localCenter.copy(sphere.center).applyMatrix4(inverse);
      object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
      const localRadius = sphere.radius /
        Math.max(worldScale.x, worldScale.y, worldScale.z, 1e-6);
      closestLocal.copy(localCenter).clamp(box.min, box.max);
      closestWorld.copy(closestLocal).applyMatrix4(object.matrixWorld);
      const worldDistance = closestWorld.distanceTo(sphere.center);
      const pressDistance = localCenter.distanceTo(pressSphereCenter);
      const overlap = pressSphereRadius + localRadius - pressDistance;
      const overlapping = overlap >= POKER_KEY_PRESS_OVERLAP;
      if (!overlapping) {
        overlapStartedAt = 0;
      } else if (overlapStartedAt === 0) {
        overlapStartedAt = now;
      }
      const dtSeconds = hasPreviousLocalCenter
        ? Math.max((now - previousTimestamp) / 1000, 1e-6)
        : 0;
      const velocityZ = hasPreviousLocalCenter
        ? (localCenter.z - previousLocalCenter.z) / dtSeconds
        : 0;
      const movingIntoKey = velocityZ <= POKER_KEY_PRESS_INWARD_VELOCITY;
      const dwellReady = overlapping && now - overlapStartedAt >= POKER_KEY_PRESS_DWELL_MS;
      const pressReady = overlapping && (movingIntoKey || dwellReady);
      if (debugVisuals != null) {
        debugVisuals.group.matrix.copy(object.matrixWorld);
        debugVisuals.group.matrixWorld.copy(object.matrixWorld);
        debugVisuals.group.matrixWorldNeedsUpdate = true;
        setDebugMaterialState(debugVisuals.statusMaterial, pressReady, overlapping);
        debugVisuals.sphere.visible = true;
        debugVisuals.sphere.position.copy(localCenter);
        debugVisuals.sphere.scale.setScalar(localRadius);
        debugVisuals.centerDot.visible = true;
        debugVisuals.centerDot.position.copy(localCenter);
        debugVisuals.closestDot.visible = true;
        debugVisuals.closestDot.position.copy(pressSphereCenter);
        debugVisuals.line.visible = true;
        debugVisuals.linePosition.setXYZ(0, localCenter.x, localCenter.y, localCenter.z);
        debugVisuals.linePosition.setXYZ(
          1,
          pressSphereCenter.x,
          pressSphereCenter.y,
          pressSphereCenter.z,
        );
        debugVisuals.linePosition.needsUpdate = true;
      }
      previousLocalCenter.copy(localCenter);
      previousTimestamp = now;
      hasPreviousLocalCenter = true;
      if (worldDistance > sphere.radius) {
        return;
      }
      intersects.push({
        distance: pressReady ? 0 : Math.max(worldDistance, sphere.radius),
        object,
        point: closestWorld.clone(),
        localPoint: closestLocal.clone(),
        uv: new THREE.Vector2(
          (closestLocal.x - box.min.x) / Math.max(1e-6, box.max.x - box.min.x),
          (closestLocal.y - box.min.y) / Math.max(1e-6, box.max.y - box.min.y),
        ),
        normal: new THREE.Vector3(0, 0, 1),
      } as THREE.Intersection);
    };
    return () => {
      if (object.spherecast != null) {
        object.spherecast = undefined;
      }
      if (debugVisuals != null) {
        scene.remove(debugVisuals.group);
      }
    };
  }, [face, minHeight, minWidth, pixelSize, scene]);

  return (
    <Container
      ref={outerRef}
      pixelSize={pixelSize}
      minWidth={minWidth}
      minHeight={minHeight}
      alignItems="center"
      justifyContent="center"
      {...LAYOUT_CHROME}
      {...KEYCAP_FRONT_RENDER_PROPS}
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
        {...KEYCAP_FRONT_RENDER_PROPS}
      >
        {children ?? (
          <Text
            color={tc}
            fontSize={face.fontSize}
            pixelSize={pixelSize}
            textAlign="center"
            {...KEYCAP_FRONT_RENDER_PROPS}
          >
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
