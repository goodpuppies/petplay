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
import { type NativeOverlayTextureInput, OpenVrNativeOverlays } from "./openVrNativeOverlays.ts";
import type { DmabufBankPool } from "./overlayPresenterNative.ts";
import {
  type Anchored,
  followKey,
  type RenderAnchor,
  type RenderAnchorSpace,
} from "./overlayRenderTracking.ts";
import type { PetplayRenderProps } from "./renderProps.ts";
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
/** Acceptable off-plane parallax error (metres) before redrawing a fixed stereo box quad. */
const STEREO_STALE_TOLERANCE = 0.0003;
const STEREO_TEXELS_PER_METER = 1500;

export type NativeStereoBoxQuad = {
  pose: Float32Array;
  width: number;
  height: number;
  left: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
  right: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
  redrawAfter: number;
};

const eyeOrigin = new THREE.Vector3();
const eyeToCenter = new THREE.Vector3();
const boxX = new THREE.Vector3();
const boxY = new THREE.Vector3();
const boxZ = new THREE.Vector3();
const boxCenter = new THREE.Vector3();
const boxFace = new THREE.Vector3();
const boxEye = new THREE.Vector3();
const boxCorner = new THREE.Vector3();

function throughQuad(
  eye: ArrayLike<number>,
  center: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  normal: THREE.Vector3,
  halfWidth: number,
  halfHeight: number,
  front: number,
  back: number,
): { viewMatrix: Float32Array; projectionMatrix: Float32Array } | null {
  eyeOrigin.set(Number(eye[0]), Number(eye[1]), Number(eye[2]));
  eyeToCenter.subVectors(center, eyeOrigin);
  const x = eyeToCenter.dot(right);
  const y = eyeToCenter.dot(up);
  const planeDistance = -eyeToCenter.dot(normal);
  if (!(planeDistance > 1e-3)) return null;
  const near = Math.max(0.01, planeDistance - front);
  const far = planeDistance + back + 0.01;
  const k = near / planeDistance;
  const projectionMatrix = new Float32Array(16);
  cameraScratch.makePerspective(
    (x - halfWidth) * k,
    (x + halfWidth) * k,
    (y + halfHeight) * k,
    (y - halfHeight) * k,
    near,
    far,
  ).toArray(projectionMatrix);
  const viewMatrix = new Float32Array(16);
  cameraScratch.makeBasis(right, up, normal).setPosition(eyeOrigin).invert().toArray(viewMatrix);
  return { viewMatrix, projectionMatrix };
}

/**
 * Stereo quad lying in the nearer face of a 1-mesh box (e.g. `GrabBoxFrame`), derived directly
 * from `GeometryAsset.bounds.min/max` and `worldMatrix`. Returns `null` when an eye is too close
 * or viewing edge-on (so the caller leaves it in the eye image instead of clipping).
 */
export function nativeStereoBoxQuad(
  worldMatrix: ArrayLike<number>,
  bounds: { min?: readonly [number, number, number]; max?: readonly [number, number, number] },
  head: ArrayLike<number>,
  leftEye: ArrayLike<number>,
  rightEye: ArrayLike<number>,
): NativeStereoBoxQuad | null {
  if (!bounds.min || !bounds.max) return null;
  const localHx = (bounds.max[0] - bounds.min[0]) * 0.5;
  const localHy = (bounds.max[1] - bounds.min[1]) * 0.5;
  const localHz = (bounds.max[2] - bounds.min[2]) * 0.5;
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5;

  const m = worldMatrix;
  boxX.set(Number(m[0]), Number(m[1]), Number(m[2]));
  boxY.set(Number(m[4]), Number(m[5]), Number(m[6]));
  boxZ.set(Number(m[8]), Number(m[9]), Number(m[10]));
  const halfWidth = boxX.length() * localHx;
  const halfHeight = boxY.length() * localHy;
  const halfDepth = boxZ.length() * localHz;
  if (!(halfWidth > 1e-6) || !(halfHeight > 1e-6) || !(halfDepth > 1e-6)) return null;

  boxCenter.set(
    Number(m[12]) + Number(m[0]) * cx + Number(m[4]) * cy + Number(m[8]) * cz,
    Number(m[13]) + Number(m[1]) * cx + Number(m[5]) * cy + Number(m[9]) * cz,
    Number(m[14]) + Number(m[2]) * cx + Number(m[6]) * cy + Number(m[10]) * cz,
  );
  boxX.normalize();
  boxY.addScaledVector(boxX, -boxY.dot(boxX)).normalize();
  boxZ.crossVectors(boxX, boxY);

  boxEye.set(Number(head[0]), Number(head[1]), Number(head[2])).sub(boxCenter);
  const side = boxEye.dot(boxZ) >= 0 ? 1 : -1;
  boxX.multiplyScalar(side);
  boxZ.multiplyScalar(side);
  boxFace.copy(boxCenter).addScaledVector(boxZ, halfDepth);

  const slideRoom = halfDepth;
  const margin = slideRoom + 0.02 * Math.max(halfWidth, halfHeight);
  const quadHalfWidth = halfWidth + margin;
  const quadHalfHeight = halfHeight + margin;
  const depth = halfDepth * 2;

  let nearest = Infinity;
  for (const eye of [leftEye, rightEye]) {
    boxEye.set(Number(eye[0]), Number(eye[1]), Number(eye[2])).sub(boxFace);
    const distance = boxEye.dot(boxZ);
    if (!(distance > Math.max(0.08, depth))) return null;
    nearest = Math.min(nearest, distance);
    const ex = boxEye.dot(boxX);
    const ey = boxEye.dot(boxY);
    const slide = depth / (distance + depth);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        boxCorner.set(sx * halfWidth, sy * halfHeight, 0);
        const px = boxCorner.x + (ex - boxCorner.x) * slide;
        const py = boxCorner.y + (ey - boxCorner.y) * slide;
        if (Math.abs(px) > halfWidth + slideRoom || Math.abs(py) > halfHeight + slideRoom) {
          return null;
        }
      }
    }
  }
  const left = throughQuad(
    leftEye,
    boxFace,
    boxX,
    boxY,
    boxZ,
    quadHalfWidth,
    quadHalfHeight,
    0.01,
    depth,
  );
  const right = throughQuad(
    rightEye,
    boxFace,
    boxX,
    boxY,
    boxZ,
    quadHalfWidth,
    quadHalfHeight,
    0.01,
    depth,
  );
  if (!left || !right) return null;
  const pose = new Float32Array(16);
  cameraScratch.makeBasis(boxX, boxY, boxZ).setPosition(boxFace).toArray(pose);
  return {
    pose,
    width: quadHalfWidth * 2,
    height: quadHalfHeight * 2,
    left,
    right,
    redrawAfter: Math.max(0.002, STEREO_STALE_TOLERANCE * nearest / depth),
  };
}

function stereoKeyOf(
  instance: WebXRRaythreeRenderPayload["leftEye"]["frame"]["instances"][number],
): string | null {
  const rp = instance.renderProps as PetplayRenderProps | undefined;
  if (rp?.overlayRole !== "stereo" || rp.nativeOverlay === false) return null;
  return `stereo.${rp.overlayKey ?? instance.nodeId}`;
}

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
  const surfaces = payload.ui.surfaces ?? [];

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

  let hasStrippedStereo = false;
  for (const instance of payload.leftEye?.frame?.instances ?? []) {
    const key = stereoKeyOf(instance);
    if (key && readySurfaceIds.has(key)) {
      hasStrippedStereo = true;
      break;
    }
  }
  if (strippedRoots.size === 0 && !hasStrippedStereo) return payload;

  const ui: WebXRRaythreeUiSnapshot = strippedRoots.size > 0
    ? {
      ...payload.ui,
      panels: payload.ui.panels.filter((p) => !strippedRoots.has(p.rootIndex)),
      texts: payload.ui.texts.filter((t) => !strippedRoots.has(t.rootIndex)),
      images: (payload.ui.images ?? []).filter((img) => !strippedRoots.has(img.rootIndex)),
      depthOnlyPanels,
    }
    : payload.ui;

  if (!hasStrippedStereo) return { ...payload, ui };
  const filterInstances = (
    instances: WebXRRaythreeRenderPayload["leftEye"]["frame"]["instances"],
  ) =>
    instances.filter((instance) => {
      const key = stereoKeyOf(instance);
      return !(key && readySurfaceIds.has(key));
    });
  const leftEye = {
    ...payload.leftEye,
    frame: { ...payload.leftEye.frame, instances: filterInstances(payload.leftEye.frame.instances) },
  };
  const rightEye = payload.rightEye === payload.leftEye ? leftEye : {
    ...payload.rightEye,
    frame: {
      ...payload.rightEye.frame,
      instances: filterInstances(payload.rightEye.frame.instances),
    },
  };
  return { ...payload, leftEye, rightEye, ui };
}

const NONE: ReadonlySet<string> = new Set();

export type NativeSharedTextureBackend = {
  createPool(width: number, height: number): DmabufBankPool | null;
  bindOverlay(overlayHandle: bigint, sharedHandle: bigint): number;
  finishFence(): number;
};

const SHARED_POOL_MAX_BYTES = 128 * 1024 * 1024;
const SHARED_RETIRE_FRAMES = 4;

export class NativePanelOverlayLayer {
  private readonly overlays: OpenVrNativeOverlays;
  private readonly sharedBackend?: NativeSharedTextureBackend;
  /** Active 2-slot zero-copy shared pools keyed by `surfaceId`. */
  private readonly sharedActive = new Map<string, { pool: DmabufBankPool; next: number }>();
  /** Retired shared pools waiting a few frames before returning to `sharedIdle`. */
  private sharedRetired: Array<{ pool: DmabufBankPool; frames: number }> = [];
  /** Idle shared pools reusable by size, bounded by `SHARED_POOL_MAX_BYTES`. */
  private sharedIdle: Array<{ size: string; bytes: number; pool: DmabufBankPool }> = [];
  private sharedIdleBytes = 0;
  /** Last rendered `(contentRevision, textureWidth, textureHeight)` per `surfaceId`. */
  private readonly drawn = new Map<string, { rev: number; w: number; h: number }>();
  /** Cached local geometry bounds by `geometryId` (for 1-mesh stereo boxes). */
  private readonly geometryBounds = new Map<
    number,
    { min?: [number, number, number]; max?: [number, number, number] }
  >();
  /** Last rendered stereo state per stereo key, to skip redraws while eyes stay within tolerance. */
  private readonly stereoDrawn = new Map<
    string,
    { geomId: number; matId: number; assetVersion: number; eyes: Float64Array; w: number; h: number }
  >();
  private readonly eyePoseScratch = new THREE.Matrix4();
  private readonly quadInvScratch = new THREE.Matrix4();
  private readonly eyeInQuadScratch = new THREE.Vector3();
  private readonly leftEyePos = new Float64Array(3);
  private readonly rightEyePos = new Float64Array(3);
  private readonly eyesInQuad = new Float64Array(6);
  private targetGeneration = -1;
  private lastEpoch: string | number | undefined;
  texelsPerPixel = 2;
  readonly stats = {
    panels: 0,
    stereo: 0,
    panelRedraws: 0,
    stereoRedraws: 0,
    frames: 0,
    transport: "gl" as "shared" | "gl",
  };

  constructor(
    overlayPointer: Deno.PointerValue,
    keyPrefix: string,
    namePrefix: string,
    sharedBackend?: NativeSharedTextureBackend,
  ) {
    this.sharedBackend = sharedBackend;
    this.stats.transport = sharedBackend ? "shared" : "gl";
    this.overlays = new OpenVrNativeOverlays(
      overlayPointer,
      keyPrefix,
      namePrefix,
      sharedBackend ? (h, sh) => sharedBackend.bindOverlay(h, sh) : undefined,
    );
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
      head?: ArrayLike<number>;
      leftEyeViewMatrix?: ArrayLike<number>;
      rightEyeViewMatrix?: ArrayLike<number>;
      devices?: Partial<Record<RenderAnchorSpace, NativeOverlayDevice>>;
      heldFollows?: { has(key: string): boolean };
      epoch?: string | number;
      assetVersion?: number;
    },
  ): void {
    if (!payload) {
      if (this.overlays.count > 0 || this.drawn.size > 0) this.retain(NONE, renderer);
      this.stats.panels = 0;
      this.stats.stereo = 0;
      return;
    }
    if (
      renderer.nativeTargetGeneration !== this.targetGeneration ||
      (view.epoch !== undefined && view.epoch !== this.lastEpoch)
    ) {
      this.drawn.clear();
      this.stereoDrawn.clear();
      this.geometryBounds.clear();
      this.targetGeneration = renderer.nativeTargetGeneration;
      this.lastEpoch = view.epoch;
    }
    for (const geom of payload.leftEye.assets.geometries) {
      if (geom.bounds) this.geometryBounds.set(geom.id, geom.bounds);
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

      let texture: NativeOverlayTextureInput | undefined;
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
        texture = this.renderPanelTexture(surface.surfaceId, rootUi, camera, renderer);
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

    // Stereo 1-mesh box outlines (`<PetplayElement renderProps={{ overlayRole: "stereo" }}>`).
    let stereoCount = 0;
    if (view.head && view.leftEyeViewMatrix && view.rightEyeViewMatrix) {
      this.eyePosition(view.leftEyeViewMatrix, this.leftEyePos);
      this.eyePosition(view.rightEyeViewMatrix, this.rightEyePos);
      const headPos = [Number(view.head[12]), Number(view.head[13]), Number(view.head[14])];
      const assetVersion = view.assetVersion ?? 0;
      const depthPanels: WebXRRaythreeUiPanelSnapshot[] = [];
      for (const s of surfaces) {
        if (s.depthPanelIndex !== undefined) {
          const bg = payload.ui.panels[s.depthPanelIndex];
          if (bg) depthPanels.push(bg);
        }
      }
      for (const instance of payload.leftEye.frame.instances) {
        const key = stereoKeyOf(instance);
        if (!key || keep.has(key)) continue;
        const bounds = this.geometryBounds.get(instance.geometryId);
        if (!bounds) continue;
        const quad = nativeStereoBoxQuad(
          instance.worldMatrix,
          bounds,
          headPos,
          this.leftEyePos,
          this.rightEyePos,
        );
        if (!quad) continue;
        keep.add(key);
        stereoCount++;
        const eyeWidth = nativeTextureSize(quad.width * STEREO_TEXELS_PER_METER, 2048);
        const eyeHeight = nativeTextureSize(quad.height * STEREO_TEXELS_PER_METER, 2048);

        this.quadInvScratch.fromArray(quad.pose as unknown as number[]).invert();
        this.eyeInQuadScratch.fromArray(this.leftEyePos).applyMatrix4(this.quadInvScratch).toArray(
          this.eyesInQuad,
          0,
        );
        this.eyeInQuadScratch.fromArray(this.rightEyePos).applyMatrix4(this.quadInvScratch).toArray(
          this.eyesInQuad,
          3,
        );

        const prev = this.stereoDrawn.get(key);
        let movedEnough = !prev ||
          prev.geomId !== instance.geometryId ||
          prev.matId !== instance.materialId ||
          prev.assetVersion !== assetVersion ||
          prev.w !== eyeWidth ||
          prev.h !== eyeHeight;
        if (!movedEnough && prev) {
          const thrSq = quad.redrawAfter * quad.redrawAfter;
          const dl = (this.eyesInQuad[0]! - prev.eyes[0]!) ** 2 +
            (this.eyesInQuad[1]! - prev.eyes[1]!) ** 2 +
            (this.eyesInQuad[2]! - prev.eyes[2]!) ** 2;
          const dr = (this.eyesInQuad[3]! - prev.eyes[3]!) ** 2 +
            (this.eyesInQuad[4]! - prev.eyes[4]!) ** 2 +
            (this.eyesInQuad[5]! - prev.eyes[5]!) ** 2;
          movedEnough = dl > thrSq || dr > thrSq;
        }

        let texture: NativeOverlayTextureInput | undefined;
        if (movedEnough && redrawsThisFrame < MAX_PANEL_REDRAWS_PER_FRAME) {
          texture = this.renderStereoTexture(
            key,
            eyeWidth,
            eyeHeight,
            payload.leftEye,
            [instance],
            quad,
            depthPanels,
            renderer,
          );
          this.stereoDrawn.set(key, {
            geomId: instance.geometryId,
            matId: instance.materialId,
            assetVersion,
            eyes: this.eyesInQuad.slice(),
            w: eyeWidth,
            h: eyeHeight,
          });
          redrawsThisFrame++;
          this.stats.stereoRedraws++;
        }

        this.overlays.present({
          key,
          pose: quad.pose,
          device: nativePanelAttachment(
            (instance as Anchored).renderAnchor,
            quad.pose,
            view.devices,
            view.heldFollows,
          ) ?? undefined,
          widthMeters: quad.width,
          texelAspect: (quad.width / eyeWidth) / (quad.height / eyeHeight),
          texture,
          stereo: true,
          sortOrder: 0,
        });
      }
    }

    this.retain(keep, renderer);
    this.stats.panels = keep.size - stereoCount;
    this.stats.stereo = stereoCount;
    this.stats.frames++;
  }

  private eyePosition(viewMatrix: ArrayLike<number>, target: Float64Array): void {
    const e = this.eyePoseScratch.fromArray(viewMatrix as number[]).invert().elements;
    target[0] = e[12]!;
    target[1] = e[13]!;
    target[2] = e[14]!;
  }

  private renderStereoTexture(
    key: string,
    eyeWidth: number,
    eyeHeight: number,
    extraction: WebXRRaythreeRenderPayload["leftEye"],
    instances: WebXRRaythreeRenderPayload["leftEye"]["frame"]["instances"],
    eyes: {
      left: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
      right: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
    },
    depthPanels: WebXRRaythreeUiPanelSnapshot[],
    renderer: WebXROverlayRaylib,
  ): NativeOverlayTextureInput {
    const backend = this.sharedBackend;
    if (backend) {
      const entry = this.acquireSharedPool(key, eyeWidth * 2, eyeHeight, backend);
      if (entry) {
        const slotIdx = entry.next;
        entry.next ^= 1;
        const slot = entry.pool.slots[slotIdx]!;
        const lockErr = entry.pool.lockBank(slotIdx);
        if (lockErr !== 0) throw new Error(`Shared native stereo lockBank failed: ${lockErr}`);
        try {
          renderer.renderNativeStereoIntoFbo(
            slot,
            eyeWidth,
            eyeHeight,
            extraction,
            instances,
            eyes,
            depthPanels,
          );
          backend.finishFence();
        } finally {
          entry.pool.unlockBank(slotIdx);
        }
        this.stats.transport = "shared";
        return { sharedHandle: slot.sharedHandle, width: eyeWidth * 2, height: eyeHeight };
      }
    }
    this.stats.transport = "gl";
    return {
      id: renderer.renderNativeStereo(
        key,
        eyeWidth,
        eyeHeight,
        extraction,
        instances,
        eyes,
        depthPanels,
      ),
      width: eyeWidth * 2,
      height: eyeHeight,
    };
  }

  private renderPanelTexture(
    key: string,
    rootUi: WebXRRaythreeUiSnapshot,
    camera: NativePanelCamera,
    renderer: WebXROverlayRaylib,
  ): NativeOverlayTextureInput {
    const backend = this.sharedBackend;
    if (backend) {
      const entry = this.acquireSharedPool(key, camera.textureWidth, camera.textureHeight, backend);
      if (entry) {
        const slotIdx = entry.next;
        entry.next ^= 1;
        const slot = entry.pool.slots[slotIdx]!;
        const lockErr = entry.pool.lockBank(slotIdx);
        if (lockErr !== 0) throw new Error(`Shared native panel lockBank failed: ${lockErr}`);
        try {
          renderer.renderNativePanelIntoFbo(
            slot,
            camera.textureWidth,
            camera.textureHeight,
            rootUi,
            camera,
          );
          backend.finishFence();
        } finally {
          entry.pool.unlockBank(slotIdx);
        }
        this.stats.transport = "shared";
        return {
          sharedHandle: slot.sharedHandle,
          width: camera.textureWidth,
          height: camera.textureHeight,
        };
      }
    }
    this.stats.transport = "gl";
    return {
      id: renderer.renderNativePanel(key, rootUi, camera),
      width: camera.textureWidth,
      height: camera.textureHeight,
    };
  }

  private acquireSharedPool(
    key: string,
    width: number,
    height: number,
    backend: NativeSharedTextureBackend,
  ): { pool: DmabufBankPool; next: number } | null {
    let entry = this.sharedActive.get(key);
    if (entry && (entry.pool.width !== width || entry.pool.height !== height)) {
      this.sharedRetired.push({ pool: entry.pool, frames: SHARED_RETIRE_FRAMES });
      this.sharedActive.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const size = `${width}x${height}`;
      let pool: DmabufBankPool | null = null;
      for (let i = this.sharedIdle.length - 1; i >= 0; i--) {
        const idle = this.sharedIdle[i]!;
        if (idle.size === size) {
          this.sharedIdle.splice(i, 1);
          this.sharedIdleBytes -= idle.bytes;
          pool = idle.pool;
          break;
        }
      }
      pool ??= backend.createPool(width, height);
      if (!pool) return null;
      entry = { pool, next: 0 };
      this.sharedActive.set(key, entry);
    }
    return entry;
  }

  private poolSharedPool(pool: DmabufBankPool): void {
    const bytes = pool.width * pool.height * 8 * pool.bankCount;
    if (bytes > SHARED_POOL_MAX_BYTES) {
      pool.destroy();
      return;
    }
    this.sharedIdle.push({ size: `${pool.width}x${pool.height}`, bytes, pool });
    this.sharedIdleBytes += bytes;
    while (this.sharedIdleBytes > SHARED_POOL_MAX_BYTES && this.sharedIdle.length > 0) {
      const oldest = this.sharedIdle.shift()!;
      this.sharedIdleBytes -= oldest.bytes;
      oldest.pool.destroy();
    }
  }

  private retain(keep: ReadonlySet<string>, renderer: WebXROverlayRaylib): void {
    this.overlays.retain(keep);
    const held = this.overlays.keys();
    renderer.retainNativeTargets(held);
    for (const [key, entry] of this.sharedActive) {
      if (held.has(key)) continue;
      this.sharedRetired.push({ pool: entry.pool, frames: SHARED_RETIRE_FRAMES });
      this.sharedActive.delete(key);
    }
    if (this.sharedRetired.length > 0) {
      this.sharedRetired = this.sharedRetired.filter((retired) => {
        if (--retired.frames > 0) return true;
        this.poolSharedPool(retired.pool);
        return false;
      });
    }
    for (const key of this.drawn.keys()) if (!held.has(key)) this.drawn.delete(key);
    for (const key of this.stereoDrawn.keys()) if (!held.has(key)) this.stereoDrawn.delete(key);
  }

  clear(renderer: WebXROverlayRaylib | null): void {
    try {
      this.overlays.cleanup();
    } catch (error) {
      console.warn("[native-overlays] cleanup:", error);
    }
    this.drawn.clear();
    this.stereoDrawn.clear();
    this.geometryBounds.clear();
    for (const entry of this.sharedActive.values()) entry.pool.destroy();
    this.sharedActive.clear();
    for (const retired of this.sharedRetired) retired.pool.destroy();
    this.sharedRetired = [];
    for (const idle of this.sharedIdle) idle.pool.destroy();
    this.sharedIdle = [];
    this.sharedIdleBytes = 0;
    try {
      renderer?.clearNativeTargets();
    } catch (error) {
      console.warn("[native-overlays] target cleanup:", error);
    }
  }
}
