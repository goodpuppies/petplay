/**
 * Native SteamVR quad layer for flat UI panels (`overlayPresentMode: "native"`).
 *
 * Built cleanly on `ui.surfaces` (stable `surfaceId`, monotonic `contentRevision`, unified
 * `depthPanelIndex`, `nativeOverlay`/`dynamicOverlay` from `<PetplayElement>`):
 * - Never strips a UI panel from the eye image until its SteamVR quad is live and ready.
 * - Runs AFTER panorama submission so panel redraws never add latency to the panorama.
 * - Caps panel redraws per frame so large windows (Settings) do not hitch the render loop.
 */
import * as THREE from "three";
import { OpenVrNativeOverlays } from "./openVrNativeOverlays.ts";
import { followKey, type RenderAnchor, type RenderAnchorSpace } from "./overlayRenderTracking.ts";
import type { WebXROverlayRaylib } from "./webxrOverlayRaylib.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import type {
  WebXRRaythreeUiPanelSnapshot,
  WebXRRaythreeUiSnapshot,
  WebXRRaythreeUiSurfaceSnapshot,
} from "./webxrRaythreeUi.ts";

export type NativeOverlayDevice = {
  index: number;
  pose: ArrayLike<number>;
  /**
   * Optional static column-major 4×4 transform from `anchor.space` into raw tracked-device space
   * (e.g. controller tip / grip offset). When present (or omitted for identity spaces like `head`),
   * `nativePanelAttachment` composes `anchorToDevice * anchor.localMatrix` directly without
   * inverting the moving `pose`, keeping device-relative transforms bit-stable across frames.
   */
  anchorToDevice?: ArrayLike<number>;
};

export type NativePanelCamera = {
  viewMatrix: Float32Array;
  projectionMatrix: Float32Array;
  textureWidth: number;
  textureHeight: number;
  pose: Float32Array;
  widthMeters: number;
  texelAspect: number;
};

const PANEL_DEPTH_RANGE = 10;
/** Small margin around a root's rectangle so hover lift / focus rings at the edge don't clip. */
const PANEL_OVERFLOW_MARGIN = 1.04;
const MAX_PANEL_REDRAWS_PER_FRAME = 3;

const cameraScratch = new THREE.Matrix4();
const axisX = new THREE.Vector3();
const axisY = new THREE.Vector3();
const axisZ = new THREE.Vector3();
const origin = new THREE.Vector3();
const attachDevice = new THREE.Matrix4();
const attachRelative = new THREE.Matrix4();
const attachX = new THREE.Vector3();
const attachY = new THREE.Vector3();
const attachZ = new THREE.Vector3();
const attachOrigin = new THREE.Vector3();

/** Quantize texture dimensions into steps (64 up to 2048, 128 above) to maximize target reuse. */
export function nativeTextureSize(texels: number, max = 4096): number {
  const step = texels > 2048 ? 128 : 64;
  return Math.min(max, Math.max(step, Math.ceil(texels / step - 1e-6) * step));
}

/**
 * Orthographic camera framing a uikit surface's rectangle (`[-0.5, 0.5]` in X/Y with a small
 * overflow margin). Returns `null` when the surface transform is degenerate.
 */
export function nativePanelCamera(
  surface: Pick<WebXRRaythreeUiSurfaceSnapshot, "worldMatrix" | "pixelWidth" | "pixelHeight">,
  texelsPerPixel = 2,
  maxTextureSize = 4096,
): NativePanelCamera | null {
  if (!(surface.pixelWidth > 0) || !(surface.pixelHeight > 0)) return null;
  const m = surface.worldMatrix;
  axisX.set(Number(m[0]), Number(m[1]), Number(m[2]));
  axisY.set(Number(m[4]), Number(m[5]), Number(m[6]));
  axisZ.crossVectors(axisX, axisY);
  const area = axisZ.length();
  if (!(area > 1e-12)) return null;
  axisZ.divideScalar(area);
  origin.set(Number(m[12]), Number(m[13]), Number(m[14]));

  cameraScratch.makeBasis(axisX, axisY, axisZ).setPosition(origin);
  const viewMatrix = new Float32Array(16);
  cameraScratch.invert().toArray(viewMatrix);

  const half = 0.5 * PANEL_OVERFLOW_MARGIN;
  const projectionMatrix = new Float32Array(16);
  cameraScratch.makeOrthographic(-half, half, half, -half, -PANEL_DEPTH_RANGE, PANEL_DEPTH_RANGE)
    .toArray(projectionMatrix);

  const widthMeters = axisX.length() * PANEL_OVERFLOW_MARGIN;
  const heightMeters = axisY.length() * PANEL_OVERFLOW_MARGIN;
  axisX.divideScalar(axisX.length());
  axisY.crossVectors(axisZ, axisX).normalize();
  const pose = new Float32Array(16);
  cameraScratch.makeBasis(axisX, axisY, axisZ).setPosition(origin).toArray(pose);

  const rawW = surface.pixelWidth * PANEL_OVERFLOW_MARGIN * texelsPerPixel;
  const rawH = surface.pixelHeight * PANEL_OVERFLOW_MARGIN * texelsPerPixel;
  const scale = Math.min(1, maxTextureSize / Math.max(rawW, rawH));
  const textureWidth = nativeTextureSize(rawW * scale, maxTextureSize);
  const textureHeight = nativeTextureSize(rawH * scale, maxTextureSize);
  const texelAspect = (widthMeters / textureWidth) / (heightMeters / textureHeight);

  return {
    viewMatrix,
    projectionMatrix,
    textureWidth,
    textureHeight,
    pose,
    widthMeters,
    texelAspect,
  };
}

/**
 * Compute device-relative attachment for a surface riding a single tracked device (head, hand,
 * one-handed grab). Returns `null` for world-placed, two-handed, or grab-frozen surfaces.
 *
 * Composes `anchorToDevice * rigid(anchor.localMatrix)` directly when possible so the resulting
 * device-relative transform never depends on the moving `device.pose` and stays bit-stable.
 */
export function nativePanelAttachment(
  anchor: RenderAnchor | undefined,
  pose: ArrayLike<number>,
  devices: Partial<Record<RenderAnchorSpace, NativeOverlayDevice>> | undefined,
  heldFollows?: { has(key: string): boolean },
): { index: number; relative: Float64Array } | null {
  if (!anchor || anchor.pair) return null;
  if (anchor.follow && heldFollows?.has(followKey(anchor.space))) return null;
  const device = devices?.[anchor.space];
  if (!device) return null;

  // Prefer direct device-local composition: strips root scale from `anchor.localMatrix` (same
  // orthonormal basis as `nativePanelCamera`), then applies static `anchorToDevice` if any.
  const lm = anchor.localMatrix;
  attachX.set(Number(lm[0]), Number(lm[1]), Number(lm[2]));
  attachY.set(Number(lm[4]), Number(lm[5]), Number(lm[6]));
  attachZ.crossVectors(attachX, attachY);
  const area = attachZ.length();
  if (area > 1e-12) {
    attachZ.divideScalar(area);
    attachX.normalize();
    attachY.crossVectors(attachZ, attachX).normalize();
    attachOrigin.set(Number(lm[12]), Number(lm[13]), Number(lm[14]));
    attachRelative.makeBasis(attachX, attachY, attachZ).setPosition(attachOrigin);
    if (device.anchorToDevice) {
      attachDevice.fromArray(device.anchorToDevice as number[]);
      attachRelative.premultiply(attachDevice);
    }
    return { index: device.index, relative: new Float64Array(attachRelative.elements) };
  }

  // Fallback for degenerate local matrices: derive from world poses.
  attachDevice.fromArray(device.pose as number[]);
  if (!(Math.abs(attachDevice.determinant()) > 1e-9)) return null;
  attachRelative.fromArray(pose as number[]).premultiply(attachDevice.invert());
  return { index: device.index, relative: new Float64Array(attachRelative.elements) };
}

/**
 * Strip only UI surfaces whose SteamVR quads are *already live and confirmed* (`readySurfaceIds`)
 * from `payload` for the eye pass, keeping their background panels in `ui.depthOnlyPanels`.
 * Surfaces not yet primed stay in the eye image so UI can never vanish.
 */
export function stripReadyNativePanels(
  payload: WebXRRaythreeRenderPayload,
  readySurfaceIds: ReadonlySet<string>,
): WebXRRaythreeRenderPayload {
  if (readySurfaceIds.size === 0) return payload;
  const surfaces = payload.ui.surfaces;
  if (!surfaces || surfaces.length === 0) return payload;

  const strippedRoots = new Set<number>();
  const depthOnlyPanels: WebXRRaythreeUiPanelSnapshot[] = [];
  for (const surface of surfaces) {
    if (surface.nativeOverlay === false) continue;
    if (!readySurfaceIds.has(surface.surfaceId)) continue;
    strippedRoots.add(surface.rootIndex);
    if (surface.depthPanelIndex !== undefined) {
      const bg = payload.ui.panels[surface.depthPanelIndex];
      if (bg) depthOnlyPanels.push(bg);
    }
  }
  if (strippedRoots.size === 0) return payload;

  const ui: WebXRRaythreeUiSnapshot = {
    ...payload.ui,
    panels: payload.ui.panels.filter((p) => !strippedRoots.has(p.rootIndex)),
    texts: payload.ui.texts.filter((t) => !strippedRoots.has(t.rootIndex)),
    images: (payload.ui.images ?? []).filter((img) => !strippedRoots.has(img.rootIndex)),
    depthOnlyPanels,
  };
  return { ...payload, ui };
}

const NONE: ReadonlySet<string> = new Set();

export class NativePanelOverlayLayer {
  private readonly overlays: OpenVrNativeOverlays;
  /** Last rendered `(contentRevision, textureWidth, textureHeight)` per `surfaceId`. */
  private readonly drawn = new Map<string, { rev: number; w: number; h: number }>();
  private targetGeneration = -1;
  private lastEpoch: string | number | undefined;
  texelsPerPixel = 2;
  readonly stats = {
    panels: 0,
    panelRedraws: 0,
    frames: 0,
  };

  constructor(overlayPointer: Deno.PointerValue, keyPrefix: string, namePrefix: string) {
    this.overlays = new OpenVrNativeOverlays(overlayPointer, keyPrefix, namePrefix);
  }

  /** Surfaces whose SteamVR quads are live and safe to omit from the eye image. */
  readySurfaceIds(): ReadonlySet<string> {
    return this.overlays.readyKeys();
  }

  status() {
    return {
      ...this.stats,
      spareOverlays: this.overlays.spare,
      sizeMismatches: this.overlays.mismatches,
      overlays: this.overlays.status(),
    };
  }

  /**
   * Present all eligible `ui.surfaces` as SteamVR quads. Intended to run AFTER the panorama is
   * submitted so panel redraws never stall panorama presentation.
   */
  present(
    payload: WebXRRaythreeRenderPayload | null,
    renderer: WebXROverlayRaylib,
    view: {
      devices?: Partial<Record<RenderAnchorSpace, NativeOverlayDevice>>;
      heldFollows?: { has(key: string): boolean };
      epoch?: string | number;
    },
  ): void {
    if (!payload) {
      if (this.overlays.count > 0 || this.drawn.size > 0) this.retain(NONE, renderer);
      this.stats.panels = 0;
      return;
    }
    if (
      renderer.nativeTargetGeneration !== this.targetGeneration ||
      (view.epoch !== undefined && view.epoch !== this.lastEpoch)
    ) {
      this.drawn.clear();
      this.targetGeneration = renderer.nativeTargetGeneration;
      this.lastEpoch = view.epoch;
    }

    const surfaces = payload.ui.surfaces ?? [];
    const eligible: Array<{ surface: WebXRRaythreeUiSurfaceSnapshot; camera: NativePanelCamera }> =
      [];
    const keep = new Set<string>();
    for (const surface of surfaces) {
      if (surface.nativeOverlay === false) continue;
      if (keep.has(surface.surfaceId)) continue;
      const camera = nativePanelCamera(surface, this.texelsPerPixel);
      if (!camera) continue;
      keep.add(surface.surfaceId);
      eligible.push({ surface, camera });
    }

    // Group UI items by rootIndex once for surfaces that actually need a redraw this frame.
    let redrawsThisFrame = 0;
    let panelsByRoot: Map<number, WebXRRaythreeUiPanelSnapshot[]> | null = null;
    let textsByRoot: Map<number, WebXRRaythreeUiSnapshot["texts"]> | null = null;
    let imagesByRoot: Map<number, WebXRRaythreeUiSnapshot["images"]> | null = null;

    const ensureGrouped = () => {
      if (panelsByRoot) return;
      panelsByRoot = new Map();
      textsByRoot = new Map();
      imagesByRoot = new Map();
      for (const p of payload.ui.panels) {
        let list = panelsByRoot.get(p.rootIndex);
        if (!list) panelsByRoot.set(p.rootIndex, list = []);
        list.push(p);
      }
      for (const t of payload.ui.texts) {
        let list = textsByRoot.get(t.rootIndex);
        if (!list) textsByRoot.set(t.rootIndex, list = []);
        list.push(t);
      }
      for (const img of payload.ui.images ?? []) {
        let list = imagesByRoot.get(img.rootIndex);
        if (!list) imagesByRoot.set(img.rootIndex, list = []);
        list.push(img);
      }
    };

    // Prioritize never-drawn surfaces first so new panels appear immediately within the redraw cap.
    eligible.sort((a, b) => {
      const aNew = this.drawn.has(a.surface.surfaceId) ? 1 : 0;
      const bNew = this.drawn.has(b.surface.surfaceId) ? 1 : 0;
      return aNew - bNew;
    });

    for (const { surface, camera } of eligible) {
      const prev = this.drawn.get(surface.surfaceId);
      const needsDraw = !prev ||
        surface.dynamicOverlay === true ||
        prev.rev !== surface.contentRevision ||
        prev.w !== camera.textureWidth ||
        prev.h !== camera.textureHeight;

      let texture: { id: number; width: number; height: number } | undefined;
      if (needsDraw && redrawsThisFrame < MAX_PANEL_REDRAWS_PER_FRAME) {
        ensureGrouped();
        const rootUi: WebXRRaythreeUiSnapshot = {
          textRendering: payload.ui.textRendering,
          panels: panelsByRoot!.get(surface.rootIndex) ?? [],
          texts: textsByRoot!.get(surface.rootIndex) ?? [],
          images: imagesByRoot!.get(surface.rootIndex) ?? [],
        };
        if (rootUi.panels.length + rootUi.texts.length + rootUi.images.length === 0) {
          keep.delete(surface.surfaceId);
          continue;
        }
        texture = {
          id: renderer.renderNativePanel(surface.surfaceId, rootUi, camera),
          width: camera.textureWidth,
          height: camera.textureHeight,
        };
        this.drawn.set(surface.surfaceId, {
          rev: surface.contentRevision,
          w: camera.textureWidth,
          h: camera.textureHeight,
        });
        redrawsThisFrame++;
        this.stats.panelRedraws++;
      }

      this.overlays.present({
        key: surface.surfaceId,
        pose: camera.pose,
        device: nativePanelAttachment(
          surface.renderAnchor,
          camera.pose,
          view.devices,
          view.heldFollows,
        ) ?? undefined,
        widthMeters: camera.widthMeters,
        texelAspect: camera.texelAspect,
        texture,
        sortOrder: 0,
      });
    }

    this.retain(keep, renderer);
    this.stats.panels = keep.size;
    this.stats.frames++;
  }

  private retain(keep: ReadonlySet<string>, renderer: WebXROverlayRaylib): void {
    this.overlays.retain(keep);
    const held = this.overlays.keys();
    renderer.retainNativeTargets(held);
    for (const key of this.drawn.keys()) if (!held.has(key)) this.drawn.delete(key);
  }

  clear(renderer: WebXROverlayRaylib | null): void {
    try {
      this.overlays.cleanup();
    } catch (error) {
      console.warn("[native-overlays] cleanup:", error);
    }
    this.drawn.clear();
    try {
      renderer?.clearNativeTargets();
    } catch (error) {
      console.warn("[native-overlays] target cleanup:", error);
    }
  }
}
