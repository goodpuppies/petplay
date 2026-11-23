import { keyboardRepeat } from "./keyRepeat.ts";
import type { KeyPhase } from "./keyHold.ts";
import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useFrame, useThree } from "@react-three/fiber/webgpu";
import { Container, Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
import type { NormalizedKeyFace } from "./types.ts";
import type { EventHandlersProperties } from "../../../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/events.ts";
import type {
  KeyboardLayoutJson,
  KeyboardLayoutMode,
  KeyboardLocaleId,
  KeyboardLogicEvent,
  KeyboardSink,
  LayoutFormat,
  ModifierSnapshot,
} from "./types.ts";
import { keyTextColor, tokenBackground, tokenBorderColor } from "./theme.ts";
import { COLOR } from "../ui/tokens.ts";
import {
  getMainGroupRows,
  isModifierLatchedVisual,
  keyboardColumns,
  resolveLabel,
  type RowItem,
  STICKY_SCAN_MODIFIERS,
  type StickyModifier,
} from "./keyboardLayout.ts";
import { stripJsonComments } from "./parseJsonComments.ts";
import { InteractiveKeyCap } from "./keyboardKeyInteraction.tsx";
import { useSpatialAudio } from "../spatialAudio.tsx";
import { useSetting } from "../../settings.ts";
import { emitKeyboardEvent } from "./keyEvents.ts";
import {
  keyboardFormatFor,
  keyLegendFromScan,
  resolveKeyboardLocale,
  scanCodeHexToNumber,
  useKeyboardLocale,
} from "./keyboardLocale.ts";

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
const POKER_KEY_PRESS_OVERLAP_THRESHOLD = 0.005;
/** `PETPLAY_POKER_DEBUG=1` draws the H key's poke hit volume and press state. */
const SHOW_POKER_DEBUG = Deno.env.get("PETPLAY_POKER_DEBUG") === "1";
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
  return SHOW_POKER_DEBUG && face.scanCodeHex.toUpperCase() === POKER_DEBUG_KEY_SCAN_CODE;
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
/**
 * Tray behind the key groups. Pure black, the same ground the wrist overlay and
 * the contextual menu sit on, so the keyboard reads as part of one system
 * rather than a separate widget.
 */
export const DEFAULT_KEYBOARD_COLUMN_BACKGROUND = COLOR.ground;

/**
 * Radius of a key cap, and of the tray that holds them.
 *
 * Concentric, the same rule the rest of the UI follows: a child's radius is its
 * parent's minus the inset between them, so the band between the two curves
 * stays a constant width. The tray's inset is its own padding, below.
 */
const KEY_RADIUS = 12;
const TRAY_PADDING_EXTRA = 2;

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
    /**
     * The cap's border width. Interactive caps pass the width they will hold: a cap built with a
     * different one restyles and re-lays out the whole keyboard on its first effect.
     */
    borderWidth?: number;
    /** uikit local Z (meters × pixelSize); negative = depress into board. */
    transformTranslateZ?: number;
    transformScaleX?: number;
    transformScaleY?: number;
    visualRef?: React.Ref<unknown>;
  }
  & Pick<
    EventHandlersProperties,
    | "onPointerDown"
    | "onPointerUp"
    | "onPointerCancel"
    | "onPointerOut"
    | "onClick"
    | "onPointerOver"
  >;

/**
 * Visual-only key cap: colors and typography shell (no pointer handlers).
 *
 * Memoized: parents re-render on unrelated hover/selection changes, and this key cap owns an
 * expensive effect (Box3 + `spherecast` closure) that must not re-run per parent render.
 */
export const KeyCapChrome = React.memo(function KeyCapChrome(
  {
    face,
    minWidth,
    minHeight,
    pixelSize,
    children,
    pressedVisual = false,
    borderWidth = pressedVisual ? 3 : 0,
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
      // It lives at the scene root and only follows the key from its first
      // spherecast; until then it would sit at the world origin.
      debugVisuals.group.visible = false;
      scene.add(debugVisuals.group);
    }
    const inverse = new THREE.Matrix4();
    const localCenter = new THREE.Vector3();
    const closestLocal = new THREE.Vector3();
    const closestWorld = new THREE.Vector3();
    const worldScale = new THREE.Vector3();
    let isPressed = false;
    object.spherecast = (sphere, intersects) => {
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

      // Press when transitioning from 0 overlap to high overlap
      // Rearm only when overlap returns to 0
      const atThreshold = overlap >= POKER_KEY_PRESS_OVERLAP_THRESHOLD;
      const atZero = overlap <= 0;

      let pressReady = false;
      if (!isPressed && atThreshold) {
        // Transition from 0 to high overlap - trigger press
        isPressed = true;
        pressReady = true;
      } else if (isPressed && atZero) {
        // Return to 0 overlap - rearm
        isPressed = false;
      }

      if (debugVisuals != null) {
        debugVisuals.group.matrix.copy(object.matrixWorld);
        debugVisuals.group.matrixWorld.copy(object.matrixWorld);
        debugVisuals.group.matrixWorldNeedsUpdate = true;
        debugVisuals.group.visible = true;
        setDebugMaterialState(debugVisuals.statusMaterial, pressReady, atThreshold);
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
        borderWidth={borderWidth}
        borderColor={borderC}
        borderRadius={KEY_RADIUS}
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
});

export type KeyboardRowViewProps = {
  faces: (NormalizedKeyFace | { spacer: true; width: number; height: number })[];
  keyWidth: number;
  keyPadding: number;
  keyRowHeight: number;
  pixelSize: number;
  renderKey: (face: NormalizedKeyFace) => React.ReactNode;
  renderSpacer: (width: number, height: number) => React.ReactNode;
  /**
   * A ray that lands in the padding between two caps belongs to one of them:
   * without this the space between keys is dead and snapping between two keys
   * types nothing. Gaps forward to the key that follows them.
   */
  activateGap?: (face: NormalizedKeyFace) => void;
};

export function KeyboardRowView(
  { faces, keyWidth, keyPadding, keyRowHeight, pixelSize, renderKey, renderSpacer, activateGap }:
    KeyboardRowViewProps,
) {
  // Avoid flex `gapColumn` — in this uikit build it can allocate visible (often white) gap panels.
  const rowChildren: React.ReactNode[] = [];
  for (let i = 0; i < faces.length; i++) {
    const cell = faces[i]!;
    if (i > 0) {
      const neighbour = activateGap != null && !("spacer" in cell && cell.spacer)
        ? cell as NormalizedKeyFace
        : null;
      rowChildren.push(
        <Container
          key={`h-gap-${i}`}
          pixelSize={pixelSize}
          minWidth={keyPadding}
          minHeight={1}
          alignSelf="stretch"
          {...(neighbour == null ? {} : {
            onPointerDown: (event: { pointerType?: string }) => {
              if (event.pointerType === "grab") return;
              activateGap!(neighbour);
            },
          })}
          {...LAYOUT_CHROME}
        />,
      );
    }
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
      // Every row occupies exactly one band. A tall key (ISO/JIS Enter, JSON
      // `height` > 1) has to spill into the next row's band, where the layout
      // reserves its footprint with a spacer; letting it stretch its own row
      // instead pushed every following row down and left the board overflowing
      // its panel and grab box.
      height={keyRowHeight}
      {...LAYOUT_CHROME}
    >
      {rowChildren}
    </Container>
  );
}

export type KeyboardRowGapProps = {
  /** The row below the gap; the gap is split into segments matching its cells. */
  faces: RowItem[];
  keyWidth: number;
  keyPadding: number;
  pixelSize: number;
  activate: (face: NormalizedKeyFace) => void;
};

/**
 * The dead strip between two rows, split column by column so a ray that falls in it types the
 * key directly below the hit. One handler for the whole strip typed the row's first key wherever
 * the ray landed: Caps Lock when aiming between the top letter row and the home row.
 */
export function KeyboardRowGap(
  { faces, keyWidth, keyPadding, pixelSize, activate }: KeyboardRowGapProps,
) {
  const segment = (key: string, width: number, face: NormalizedKeyFace | null) => (
    <Container
      key={key}
      pixelSize={pixelSize}
      minWidth={width}
      minHeight={keyPadding}
      {...(face == null ? {} : {
        onPointerDown: (event: { pointerType?: string }) => {
          if (event.pointerType === "grab") return;
          activate(face);
        },
      })}
      {...LAYOUT_CHROME}
    />
  );
  const segments: React.ReactNode[] = [];
  for (let i = 0; i < faces.length; i++) {
    const cell = faces[i]!;
    // Under a spacer sits a tall key from the row above (ISO Enter), which covers this strip.
    const face = "spacer" in cell && cell.spacer ? null : cell as NormalizedKeyFace;
    // Same rule as the row's own horizontal gaps: a gap belongs to the key after it.
    if (i > 0) segments.push(segment(`g-${i}`, keyPadding, face));
    segments.push(
      segment(
        `c-${i}`,
        face == null ? keyWidth * (cell as { width: number }).width : keyWidth * face.widthMul,
        face,
      ),
    );
  }
  return (
    <Container
      pixelSize={pixelSize}
      flexDirection="row"
      height={keyPadding}
      {...LAYOUT_CHROME}
    >
      {segments}
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
      backgroundOpacity={1}
      borderWidth={0}
      // Concentric with the caps it holds: key radius plus this tray's padding.
      borderRadius={KEY_RADIUS + keyGroupsPadding + TRAY_PADDING_EXTRA}
      padding={keyGroupsPadding + TRAY_PADDING_EXTRA}
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
  /** Row set from `Keyboard.json`; defaults to the locale’s own format. */
  layoutFormat?: LayoutFormat;
  /** Legend locale; defaults to the app-wide [getKeyboardLocale](keyboardLocale.ts). */
  locale?: KeyboardLocaleId;
  columnBackground?: string;
  /** Uikit `pixelSize` for flex layout. */
  pixelSize?: number;
  /** Whole-board opacity, 0..1; uikit's `opacity` is inherited by every key and label. */
  opacity?: number;
  /** `compact` = main only; `arrows` = main + arrow cluster (default); `full` = nav + numpad. */
  layoutMode?: KeyboardLayoutMode;
  /** Optional uikit bar rendered above the key columns inside the keyboard's layout. */
  topBar?: React.ReactNode;
  /** Spacing in uikit layout units between `topBar` and the key columns. */
  topBarGap?: number;
};

/** Main block plus the arrow cluster: what xso's nav group ends with, without the nav block. */
export const DEFAULT_KEYBOARD_LAYOUT_MODE: KeyboardLayoutMode = "arrows";

/**
 * Latched modifiers that release after the next key press. Caps Lock is
 * deliberately absent: it is a `toggle` cell and latches.
 */
const STICKY_MODIFIER_KEYS = [
  "shift",
  "leftCtrl",
  "rightCtrl",
  "leftAlt",
  "rightAlt",
  "leftMeta",
  "rightMeta",
] as const satisfies readonly (keyof ModifierSnapshot)[];

/** How soon a second tap on a double-tappable modifier holds it down; XSO uses 0.25 s. */
const DOUBLE_TAP_MS = 250;

const LAYOUT_MODE_ENV_VAR = "PETPLAY_KEYBOARD_LAYOUT_MODE";
const KEYBOARD_LAYOUT_MODES: Record<string, KeyboardLayoutMode> = {
  compact: "compact",
  arrows: "arrows",
  full: "full",
};

/** [DEFAULT_KEYBOARD_LAYOUT_MODE], overridable with `PETPLAY_KEYBOARD_LAYOUT_MODE`. */
export function getKeyboardLayoutMode(): KeyboardLayoutMode {
  const requested = Deno.env.get(LAYOUT_MODE_ENV_VAR)?.trim().toLowerCase();
  if (requested == null || requested === "") {
    return DEFAULT_KEYBOARD_LAYOUT_MODE;
  }
  const mode = KEYBOARD_LAYOUT_MODES[requested];
  if (mode == null) {
    console.warn(
      `[keyboard] ignoring ${LAYOUT_MODE_ENV_VAR}="${requested}" ` +
        `(expected ${Object.keys(KEYBOARD_LAYOUT_MODES).join(", ")})`,
    );
    return DEFAULT_KEYBOARD_LAYOUT_MODE;
  }
  return mode;
}

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
      layoutFormat,
      locale: localeProp,
      columnBackground = DEFAULT_KEYBOARD_COLUMN_BACKGROUND,
      pixelSize = DEFAULT_KEYBOARD_PIXEL_SIZE,
      layoutMode = getKeyboardLayoutMode(),
      opacity = 1,
      topBar,
      topBarGap = 0,
    },
    ref,
  ) {
    const [raw, setRaw] = useState<KeyboardLayoutJson | null>(() => preloadedLayout);
    const [mods, setMods] = useState<ModifierSnapshot>(initialMods);

    // Subscribed, not read once: a locale switch has to relabel the live caps.
    const storeLocale = useKeyboardLocale();
    const locale = localeProp == null ? storeLocale : resolveKeyboardLocale(localeProp);
    const format = keyboardFormatFor(locale, layoutFormat);

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

    const sink: KeyboardSink = useMemo(
      () =>
        onKey ?? ((ev) => {
          console.log("[keyboard]", ev);
        }),
      [onKey],
    );
    const spatialAudio = useSpatialAudio();
    const typingSounds = useSetting("typingSounds");

    const emit = useCallback(
      (ev: KeyboardLogicEvent) => {
        sink(ev);
        if (ev.kind !== "key" || ev.pressed !== false) emitKeyboardEvent(ev);
      },
      [sink],
    );

    /** Modifiers a double tap holds down; the one-shot release skips them. */
    const holdLocked = useRef(new Set<StickyModifier>());
    // Mirrors `holdLocked` for rendering: held caps draw a white ring.
    const [held, setHeld] = useState<ReadonlySet<StickyModifier>>(() => new Set());
    const latchedAt = useRef<Partial<Record<StickyModifier, number>>>({});
    const setModifier = useCallback((modifier: StickyModifier, active: boolean) => {
      setMods((m) => ({ ...m, [modifier]: active }));
      emit({ kind: "modifier", modifier, active });
    }, [emit]);

    useFrame(() => keyboardRepeat.tick(), { phase: "finish" });

    const heldKeys = useRef(
      new Map<string, {
        event: KeyboardLogicEvent & { kind: "key" };
        modifiers: StickyModifier[];
      }>(),
    );
    // Release with the sink that received the downs if it changes or the keyboard unmounts.
    useEffect(() => () => {
      for (const { event, modifiers } of heldKeys.current.values()) {
        emit({ ...event, pressed: false });
        for (const modifier of modifiers) emit({ kind: "modifier", modifier, active: false });
      }
      heldKeys.current.clear();
    }, [emit]);

    const handleKey = useCallback(
      (
        face: NormalizedKeyFace,
        source: THREE.Object3D | null,
        worldPoint?: readonly [number, number, number],
        phase?: KeyPhase,
      ) => {
        if (phase === "up" || phase === "repeat") {
          const heldKey = heldKeys.current.get(face.id);
          if (heldKey == null) return;
          emit({ ...heldKey.event, pressed: phase !== "up" });
          if (phase === "up") {
            heldKeys.current.delete(face.id);
            for (const modifier of heldKey.modifiers) {
              // Another simultaneously held key may still need this one-shot modifier.
              if (
                Array.from(heldKeys.current.values()).some((key) =>
                  key.modifiers.includes(modifier)
                )
              ) continue;
              if (!holdLocked.current.has(modifier)) setModifier(modifier, false);
            }
          }
          return;
        }
        const emitKey = (event: KeyboardLogicEvent & { kind: "key" }) => {
          if (phase === "down") {
            if (heldKeys.current.has(face.id)) return;
            heldKeys.current.set(face.id, {
              event,
              modifiers: STICKY_MODIFIER_KEYS.filter((key) =>
                mods[key] && !holdLocked.current.has(key)
              ),
            });
            emit({ ...event, pressed: true });
          } else {
            emit(event);
          }
        };
        const playClick = () => {
          if (typingSounds) spatialAudio?.playAtObject(face.audio ?? "key", source, worldPoint);
        };
        if (face.useVirtualKeyCode) {
          const s = face.displayMain;
          emitKey({
            kind: "key",
            scanCode: 0,
            scanCodeHex: "00",
            char: s.length === 1 ? s : undefined,
            virtualKeyName: face.virtualName,
          });
          playClick();
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
          playClick();
          return;
        }
        const modifier = face.sticky ? STICKY_SCAN_MODIFIERS[hi] : undefined;
        if (modifier != null) {
          const now = performance.now();
          const held = holdLocked.current;
          if (held.has(modifier)) {
            held.delete(modifier);
            setHeld(new Set(held));
            setModifier(modifier, false);
          } else if (!mods[modifier]) {
            latchedAt.current[modifier] = now;
            setModifier(modifier, true);
          } else if (
            face.doubleTappable && now - (latchedAt.current[modifier] ?? -Infinity) < DOUBLE_TAP_MS
          ) {
            // Second tap in quick succession: keep it down across keys (Shift lock, Alt+Tab+Tab).
            held.add(modifier);
            setHeld(new Set(held));
          } else {
            setModifier(modifier, false);
          }
          playClick();
          return;
        }
        const { main } = keyLegendFromScan(
          locale,
          face.scanCodeHex,
          { shift: mods.shift, caps: mods.caps, altGr: mods.rightAlt },
          face.respectCapsLock,
        );
        emitKey({
          kind: "key",
          scanCode: sc,
          scanCodeHex: hi,
          char: main.length === 1 ? main : undefined,
        });
        // Dispatch input before native sound work, so feedback cannot hold up typing.
        playClick();
        // Sticky modifiers are one-shot: they apply to the key that follows and
        // release with it, so a chord does not leave Ctrl or Shift held. Caps
        // Lock is the exception — it is `toggle`, and stays latched.
        if (phase === "down") return;
        setMods((m) => {
          const latched = STICKY_MODIFIER_KEYS.filter((key) =>
            m[key] === true && !holdLocked.current.has(key)
          );
          if (latched.length === 0) {
            return m;
          }
          const next = { ...m };
          for (const key of latched) {
            next[key] = false;
            emit({ kind: "modifier", modifier: key, active: false });
          }
          return next;
        });
      },
      [emit, mods, setModifier, spatialAudio, typingSounds, locale],
    );

    // Parsing the layout allocates a fresh face object per key cell. Doing it during render gave
    // every key a new `face` identity on every render of this component, which invalidated the
    // per-key `KeyCapChrome` effect (Box3 + spherecast closure rebuild) and defeated memoization
    // for all 74 caps — including re-renders triggered by unrelated hover/selection changes.
    const layoutRows = useMemo(
      () => (raw == null ? null : getMainGroupRows(raw, format, locale)),
      [raw, format, locale],
    );

    if (layoutRows == null) {
      return null;
    }

    const { keyWidth, keyPadding, keyGroupsPadding, mainRows, navRows, numpadRows, rowH } =
      layoutRows;

    const activateFace = (face: NormalizedKeyFace) => handleKey(face, null);

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
            activateGap={activateFace}
            renderKey={(face) => (
              <InteractiveKeyCap
                key={face.id}
                face={face}
                minWidth={keyWidth * face.widthMul}
                minHeight={rowH * face.heightMul}
                pixelSize={pixelSize}
                currentLabel={resolveLabel(face, mods, locale)}
                latched={isModifierLatchedVisual(face, mods)}
                held={face.sticky &&
                  held.has(STICKY_SCAN_MODIFIERS[face.scanCodeHex.toUpperCase()])}
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
          <KeyboardRowGap
            key={`${columnId}-v-gap-${i}`}
            faces={r}
            keyWidth={keyWidth}
            keyPadding={keyPadding}
            pixelSize={pixelSize}
            activate={activateFace}
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
    const columns = keyboardColumns(layoutMode, { mainRows, navRows, numpadRows });
    const columnBlockH = Math.max(...columns.map((column) => colH(column.rows.length)));
    const columnsRow = (
      <Container
        ref={topBar == null ? ref : undefined}
        pixelSize={pixelSize}
        opacity={topBar == null ? opacity : undefined}
        flexDirection="row"
        alignItems="flex-start"
        gap={0}
        {...LAYOUT_CHROME}
      >
        {columns.flatMap((column, i) => [
          ...(i === 0 ? [] : [
            <Container
              key={`${column.id}-gap`}
              pixelSize={pixelSize}
              minWidth={keyGroupsPadding}
              minHeight={columnBlockH}
              {...LAYOUT_CHROME}
            />,
          ]),
          makeColumn(column.rows, column.id),
        ])}
      </Container>
    );
    if (topBar == null) return columnsRow;
    return (
      <Container
        ref={ref}
        pixelSize={pixelSize}
        opacity={opacity}
        flexDirection="column"
        alignItems="stretch"
        gap={0}
        {...LAYOUT_CHROME}
      >
        {topBar}
        {topBarGap > 0 && (
          <Container minHeight={topBarGap} {...LAYOUT_CHROME} />
        )}
        {columnsRow}
      </Container>
    );
  },
);

export { DEFAULT_ROW_HEIGHT };

/** @deprecated Use `KeyboardColumnShell`. */
export const KeyboardPanelChrome = KeyboardColumnShell;
/** @deprecated Use `KeyboardColumnShellProps`. */
export type KeyboardPanelChromeProps = KeyboardColumnShellProps;
