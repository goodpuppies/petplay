/**
 * Geometry for native overlays (`docs/NATIVE_OVERLAYS.md`): which scene items leave the eye image,
 * the camera that draws a panel into its own texture, the off-axis cameras that draw a 3D group
 * through a quad, and a content hash that says when a panel has to be redrawn. No GL or OpenVR
 * here, so it runs in tests. Matrices are column-major 4×4 (Three.js `Matrix4.elements`).
 */
import * as THREE from "three";
import type {
  NativePanelSnapshot,
  NativeQuadInstance,
  NativeQuadUserData,
  NativeStereoInstance,
} from "./nativeOverlayContent.ts";
import { followKey, type RenderAnchor, type RenderAnchorSpace } from "./overlayRenderTracking.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import type { WebXRRaythreeUiPanelSnapshot, WebXRRaythreeUiSnapshot } from "./webxrRaythreeUi.ts";

type Instances = WebXRRaythreeRenderPayload["leftEye"]["frame"]["instances"];

export type NativePanelPlan = { panel: NativePanelSnapshot; ui: WebXRRaythreeUiSnapshot };
export type NativeStereoPlan = {
  key: string;
  center: [number, number, number];
  radius: number;
  /** The group frames a box of this size; see `NativeStereoUserData.box`. */
  box?: [number, number, number];
  instances: Instances;
};
/** One mesh shown as a plain quad of its own; see `NativeQuadUserData`. */
export type NativeQuadPlan = NativeQuadUserData & { instance: Instances[number] };
export type NativeContentPlan = {
  /** The payload without the native content: what the eye image still draws. */
  eyePayload: WebXRRaythreeRenderPayload;
  panels: NativePanelPlan[];
  stereo: NativeStereoPlan[];
  quads: NativeQuadPlan[];
};

/** A panel background at least this opaque stands in for its root in the eyes' depth buffer. */
const DEPTH_STAND_IN_MIN_OPACITY = 0.5;

/**
 * Split a scene into what the eyes draw and what goes to native overlays. Returns `null` when
 * there is nothing native, so the usual path stays untouched.
 */
export function planNativeContent(
  payload: WebXRRaythreeRenderPayload,
  options: { panels: boolean; stereo: boolean },
): NativeContentPlan | null {
  const ui = payload.ui;
  const nativePanels = options.panels ? ui.nativePanels ?? [] : [];
  const panelOfRoot = new Map<number, number>();
  for (let i = 0; i < nativePanels.length; i++) {
    for (const rootIndex of nativePanels[i]!.rootIndices) panelOfRoot.set(rootIndex, i);
  }
  const instances = payload.leftEye.frame.instances;
  // Chrome of the panels (grab-box outlines) goes native with them and not otherwise.
  const taken = (instance: Instances[number]) => {
    const mark = options.stereo ? (instance as NativeStereoInstance).nativeStereo : undefined;
    return mark && (options.panels || !mark.withPanels) ? mark : undefined;
  };
  // What is left of the pointer (laser beams, cursor dots) goes native with the panels too.
  const quadOf = (instance: Instances[number]) =>
    options.panels && instance.kind !== "instancedMesh"
      ? (instance as NativeQuadInstance).nativeQuad
      : undefined;
  let hasMeshes = false;
  for (let i = 0; i < instances.length && !hasMeshes; i++) {
    hasMeshes = taken(instances[i]!) != null || quadOf(instances[i]!) != null;
  }
  if (panelOfRoot.size === 0 && !hasMeshes) return null;

  let eyeUi = ui;
  const panels: NativePanelPlan[] = [];
  if (panelOfRoot.size > 0) {
    const plans = nativePanels.map((panel): NativePanelPlan => ({
      panel,
      ui: { textRendering: ui.textRendering, panels: [], texts: [], images: [] },
    }));
    const keep = <T extends { rootIndex: number }>(
      items: readonly T[],
      pick: (plan: NativePanelPlan) => T[],
    ): T[] => {
      const kept: T[] = [];
      for (const item of items) {
        const index = panelOfRoot.get(item.rootIndex);
        if (index === undefined) kept.push(item);
        else pick(plans[index]!).push(item);
      }
      return kept;
    };
    eyeUi = {
      ...ui,
      panels: keep(ui.panels, (plan) => plan.ui.panels),
      texts: keep(ui.texts, (plan) => plan.ui.texts),
      images: keep(ui.images ?? [], (plan) => plan.ui.images),
      depthOnlyPanels: plans.map((plan) => depthStandIn(plan.ui.panels)).filter((p) => p != null),
    };
    for (const plan of plans) {
      if (plan.ui.panels.length + plan.ui.texts.length + plan.ui.images.length > 0) {
        panels.push(plan);
      }
    }
  }

  const stereo: NativeStereoPlan[] = [];
  const quads: NativeQuadPlan[] = [];
  let eyeLeft = payload.leftEye;
  let eyeRight = payload.rightEye;
  if (hasMeshes) {
    const groups = new Map<string, NativeStereoPlan>();
    const quadKeys = new Set<string>();
    const split = (source: Instances, collect: boolean): Instances => {
      const kept: Instances = [];
      for (const instance of source) {
        const mark = taken(instance);
        if (!mark) {
          const quad = quadOf(instance);
          if (!quad) kept.push(instance);
          else if (collect && !quadKeys.has(quad.key)) {
            quadKeys.add(quad.key);
            quads.push({ ...quad, instance });
          }
          continue;
        }
        if (!collect) continue;
        let group = groups.get(mark.key);
        if (!group) {
          group = {
            key: mark.key,
            center: [...mark.center],
            radius: mark.radius,
            ...(mark.box ? { box: mark.box } : {}),
            instances: [],
          };
          groups.set(mark.key, group);
          stereo.push(group);
        }
        group.radius = Math.max(group.radius, mark.radius);
        group.instances.push(instance);
      }
      return kept;
    };
    eyeLeft = {
      ...payload.leftEye,
      frame: { ...payload.leftEye.frame, instances: split(instances, true) },
    };
    // Extracted scene data is eye invariant; keep an aliased right eye aliased.
    eyeRight = payload.rightEye === payload.leftEye ? eyeLeft : {
      ...payload.rightEye,
      frame: {
        ...payload.rightEye.frame,
        instances: split(payload.rightEye.frame.instances, false),
      },
    };
  }
  return {
    eyePayload: { ...payload, leftEye: eyeLeft, rightEye: eyeRight, ui: eyeUi },
    panels,
    stereo,
    quads,
  };
}

/** The largest opaque panel of a root: its background. */
function depthStandIn(
  panels: readonly WebXRRaythreeUiPanelSnapshot[],
): WebXRRaythreeUiPanelSnapshot | null {
  let best: WebXRRaythreeUiPanelSnapshot | null = null;
  let bestArea = 0;
  for (const panel of panels) {
    if ((panel.data[7] ?? 0) < DEPTH_STAND_IN_MIN_OPACITY) continue;
    const area = Number(panel.data[14] ?? 0) * Number(panel.data[15] ?? 0);
    if (area > bestArea) {
      best = panel;
      bestArea = area;
    }
  }
  return best;
}

export type NativePanelCamera = {
  /** World to the panel's frame: its unit square in X and Y, metres along its normal. */
  viewMatrix: Float32Array;
  /** Orthographic, covering exactly the panel's rectangle. */
  projectionMatrix: Float32Array;
  textureWidth: number;
  textureHeight: number;
  /** Where SteamVR draws the quad: the panel's centre without its scale. */
  pose: Float32Array;
  widthMeters: number;
  /**
   * Width over height of one texel on the quad. 1 unless the panel is stretched along one axis;
   * SteamVR derives the quad's height from the texture's shape and this.
   */
  texelAspect: number;
};

const cameraScratch = new THREE.Matrix4();
const axisX = new THREE.Vector3();
const axisY = new THREE.Vector3();
const axisZ = new THREE.Vector3();
const origin = new THREE.Vector3();
/** Metres in front of and behind a panel's plane that still belong to its picture. */
const PANEL_DEPTH_RANGE = 10;

/**
 * The frame of a panel matrix: its X and Y columns as they are (the unit square's edges), a unit
 * normal, its origin. A uikit root's Z column carries no usable length, so the normal is taken
 * from X and Y. Returns false when the square has collapsed.
 */
function panelFrame(matrix: ArrayLike<number>, target: THREE.Matrix4): boolean {
  axisX.set(Number(matrix[0]), Number(matrix[1]), Number(matrix[2]));
  axisY.set(Number(matrix[4]), Number(matrix[5]), Number(matrix[6]));
  axisZ.crossVectors(axisX, axisY);
  const area = axisZ.length();
  if (!(area > 1e-12)) return false;
  axisZ.divideScalar(area);
  origin.set(Number(matrix[12]), Number(matrix[13]), Number(matrix[14]));
  target.makeBasis(axisX, axisY, axisZ).setPosition(origin);
  return true;
}

/**
 * Texture sizes of native overlays come in steps, rounded up: 64 texels up to 2048, 128 above.
 * A SteamVR overlay shows textures of one size only (see `openVrNativeOverlays.ts`), so every
 * size in use costs an overlay; in steps, panels of nearly the same size share one, and a panel
 * that grows or a window being resized passes through a handful of sizes instead of hundreds.
 * The picture always fills its texture, so the texels stop being square by a few percent, which
 * the quad's texel aspect makes up for.
 */
export function nativeTextureSize(texels: number, max = 4096): number {
  const step = texels > 2048 ? 128 : 64;
  return Math.min(max, Math.max(step, Math.ceil(texels / step - 1e-6) * step));
}

/**
 * `texelsPerPixel`: texture texels per uikit pixel, at least (see {@link nativeTextureSize}).
 * `maxTextureSize` caps the longer side; the other shrinks with it. Returns `null` for a panel
 * that cannot be drawn (collapsed transform).
 */
export function nativePanelCamera(
  panel: Pick<NativePanelSnapshot, "worldMatrix" | "pixelWidth" | "pixelHeight">,
  texelsPerPixel = 2,
  maxTextureSize = 4096,
): NativePanelCamera | null {
  if (!(panel.pixelWidth > 0) || !(panel.pixelHeight > 0)) return null;
  if (!panelFrame(panel.worldMatrix, cameraScratch)) return null;
  const viewMatrix = new Float32Array(16);
  cameraScratch.invert().toArray(viewMatrix);
  const projectionMatrix = new Float32Array(16);
  cameraScratch.makeOrthographic(-0.5, 0.5, 0.5, -0.5, -PANEL_DEPTH_RANGE, PANEL_DEPTH_RANGE)
    .toArray(projectionMatrix);

  // `panelFrame` left the square's edges in axisX and axisY, its normal in axisZ.
  const widthMeters = axisX.length();
  const heightMeters = axisY.length();
  axisX.divideScalar(widthMeters);
  // Re-orthogonalize: SteamVR takes a rigid pose.
  axisY.addScaledVector(axisX, -axisY.dot(axisX)).normalize();
  axisZ.crossVectors(axisX, axisY);
  const pose = new Float32Array(16);
  cameraScratch.makeBasis(axisX, axisY, axisZ).setPosition(origin).toArray(pose);

  let textureWidth = panel.pixelWidth * texelsPerPixel;
  let textureHeight = panel.pixelHeight * texelsPerPixel;
  const shrink = Math.min(1, maxTextureSize / Math.max(textureWidth, textureHeight));
  textureWidth = nativeTextureSize(textureWidth * shrink, maxTextureSize);
  textureHeight = nativeTextureSize(textureHeight * shrink, maxTextureSize);
  return {
    viewMatrix,
    projectionMatrix,
    textureWidth,
    textureHeight,
    pose,
    widthMeters,
    texelAspect: (widthMeters / textureWidth) / (heightMeters / textureHeight),
  };
}

export type NativeMeshQuad = {
  /** Centre of the quad: +X right, +Y up, +Z towards the viewer. */
  pose: Float32Array;
  /** Size of the quad, metres. */
  width: number;
  height: number;
  /** The camera that draws the mesh's picture: orthographic, the picture filling the texture. */
  viewMatrix: Float32Array;
  projectionMatrix: Float32Array;
  textureWidth: number;
  textureHeight: number;
  /** Width over height of one texel on the quad; see `NativePanelCamera.texelAspect`. */
  texelAspect: number;
};

/**
 * A beam's quad is this many times as tall as the beam is thick, and its texture four texels to
 * each of those: one texel is a quarter of the beam's thickness, which is what the bilinear
 * filter turns into a soft edge on either side. Along the beam the picture does not change at
 * all, so its length in texels is free. It is chosen from a few, to keep the texels within a
 * factor of two of square for any beam: SteamVR derives the quad's height from the texture's
 * shape and the texel aspect, and how far from 1 it honours that aspect is not known. (A fixed
 * texture would need an aspect of 150 for a 2 mm beam of 1.2 m.) A texture is kept while its
 * texels stay within {@link BEAM_KEEP_ASPECT}, so a beam whose length hovers at a boundary does
 * not change overlays every frame.
 */
const BEAM_QUAD_HEIGHT = 4;
const BEAM_TEXTURE_HEIGHT = 16;
const BEAM_TEXTURE_WIDTHS: readonly number[] = [64, 256, 1024, 4096];
const BEAM_KEEP_ASPECT = 2.5;
/** A flat mesh's quad is this much larger than the mesh, so its outline has texels to fade into. */
const FLAT_QUAD_MARGIN = 1.25;
const FLAT_TEXTURE = 64;

const meshAxisX = new THREE.Vector3();
const meshAxisY = new THREE.Vector3();
const meshAxisZ = new THREE.Vector3();
const meshOrigin = new THREE.Vector3();
const meshNormal = new THREE.Vector3();
const meshUp = new THREE.Vector3();
const meshFrame = new THREE.Matrix4();

/**
 * The quad that shows one thin or flat mesh (`NativeQuadUserData`), and the camera for its
 * picture.
 *
 * A **beam**'s quad holds the beam's axis and turns about it to face `head`, so the beam is seen
 * at its full thickness from wherever the head is. Its picture is drawn looking at one of the
 * beam's own faces instead, so it is the same picture however the beam is rolled or long: a band
 * across the middle of the texture, drawn once.
 *
 * A **flat** mesh's quad lies in the mesh's own plane, and its picture is the mesh seen head-on.
 *
 * `keepTextureWidth` is the texture width the mesh's quad has now, if any; see
 * {@link BEAM_KEEP_ASPECT}. Returns `null` for a mesh with no size.
 */
export function nativeMeshQuad(
  worldMatrix: ArrayLike<number>,
  shape: NativeQuadUserData["shape"],
  extent: readonly [number, number, number],
  head: ArrayLike<number>,
  keepTextureWidth?: number,
): NativeMeshQuad | null {
  const m = worldMatrix;
  meshAxisX.set(Number(m[0]), Number(m[1]), Number(m[2]));
  meshAxisY.set(Number(m[4]), Number(m[5]), Number(m[6]));
  meshAxisZ.set(Number(m[8]), Number(m[9]), Number(m[10]));
  meshOrigin.set(Number(m[12]), Number(m[13]), Number(m[14]));
  const scaleX = meshAxisX.length(), scaleY = meshAxisY.length(), scaleZ = meshAxisZ.length();
  let width: number, height: number;
  let textureWidth: number, textureHeight: number;
  const pose = new Float32Array(16);
  if (shape === "beam") {
    width = scaleZ * 2 * extent[2];
    const thickness = scaleX * 2 * extent[0];
    if (!(width > 1e-6) || !(thickness > 1e-7)) return null;
    height = thickness * BEAM_QUAD_HEIGHT;
    textureHeight = BEAM_TEXTURE_HEIGHT;
    // Texels across the beam's length for square ones, and the nearest length there is.
    const square = width / height * textureHeight;
    const off = (texels: number) => Math.max(texels / square, square / texels);
    textureWidth = BEAM_TEXTURE_WIDTHS[0]!;
    for (const texels of BEAM_TEXTURE_WIDTHS) {
      if (off(texels) < off(textureWidth)) textureWidth = texels;
    }
    if (
      keepTextureWidth != null && BEAM_TEXTURE_WIDTHS.includes(keepTextureWidth) &&
      off(keepTextureWidth) <= BEAM_KEEP_ASPECT
    ) textureWidth = keepTextureWidth;
    // The camera's frame: along the beam, across one of its faces, out of that face.
    const along = meshAxisZ.divideScalar(scaleZ);
    const across = meshAxisX.addScaledVector(along, -meshAxisX.dot(along)).normalize();
    const out = meshAxisY.crossVectors(along, across);
    // The quad's frame: along the beam, and facing the head as squarely as the beam allows.
    meshNormal.set(Number(head[0]), Number(head[1]), Number(head[2])).sub(meshOrigin);
    meshNormal.addScaledVector(along, -meshNormal.dot(along));
    if (meshNormal.lengthSq() < 1e-10) meshNormal.copy(out);
    meshNormal.normalize();
    meshUp.crossVectors(meshNormal, along);
    meshFrame.makeBasis(along, meshUp, meshNormal).setPosition(meshOrigin).toArray(pose);
    meshFrame.makeBasis(along, across, out).setPosition(meshOrigin);
  } else {
    width = scaleX * 2 * extent[0] * FLAT_QUAD_MARGIN;
    height = scaleY * 2 * extent[1] * FLAT_QUAD_MARGIN;
    if (!(width > 1e-7) || !(height > 1e-7)) return null;
    textureWidth = textureHeight = FLAT_TEXTURE;
    const right = meshAxisX.divideScalar(scaleX);
    const up = meshAxisY.addScaledVector(right, -meshAxisY.dot(right)).normalize();
    const out = meshAxisZ.crossVectors(right, up);
    meshFrame.makeBasis(right, up, out).setPosition(meshOrigin).toArray(pose);
  }
  const viewMatrix = new Float32Array(16);
  meshFrame.invert().toArray(viewMatrix);
  const projectionMatrix = new Float32Array(16);
  const depth = Math.max(width, height);
  meshFrame.makeOrthographic(-width / 2, width / 2, height / 2, -height / 2, -depth, depth)
    .toArray(projectionMatrix);
  return {
    pose,
    width,
    height,
    viewMatrix,
    projectionMatrix,
    textureWidth,
    textureHeight,
    texelAspect: (width / textureWidth) / (height / textureHeight),
  };
}

/** A tracked device behind a render-anchor space, with the pose this frame was rendered for. */
export type NativeOverlayDevice = { index: number; pose: ArrayLike<number> };

const attachDevice = new THREE.Matrix4();
const attachRelative = new THREE.Matrix4();

/**
 * A panel that rides one tracked device (parented to a hand or the head, or carried in a
 * one-handed grab) is attached to it, so SteamVR moves it at display rate instead of waiting for
 * the renderer. Its place on the device is what this frame's poses say: where the panel's `pose`
 * is, seen from the device. Returns `null` for a panel that belongs in the room: it has no
 * anchor, two hands carry it together, its grab has ended and it is held in place until the
 * scene catches up (`heldFollows`), or its device is not tracked.
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
  attachDevice.fromArray(device.pose as number[]);
  if (!(Math.abs(attachDevice.determinant()) > 1e-9)) return null;
  attachRelative.fromArray(pose as number[]).premultiply(attachDevice.invert());
  return { index: device.index, relative: new Float64Array(attachRelative.elements) };
}

export type NativeStereoQuad = {
  /** Centre of the quad: +X right, +Y up, +Z towards the viewer. */
  pose: Float32Array;
  /** Size of the quad, metres. */
  width: number;
  height: number;
  left: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
  right: { viewMatrix: Float32Array; projectionMatrix: Float32Array };
  /**
   * How far the head may move before the picture is worth drawing again, metres. The quad's
   * rectangle is exact wherever the head is; only what lies off its plane shifts, by
   * `movement * depth / distance`. Absent for a quad that turns to face the head: its picture
   * and its pose both follow the head every frame.
   */
  redrawAfter?: number;
};

/** A stale stereo picture may be off by this much, metres: about an arc minute at one metre. */
const STEREO_STALE_TOLERANCE = 0.0003;

const eyeToCenter = new THREE.Vector3();
const eyeOrigin = new THREE.Vector3();

/**
 * The camera that draws the scene from `eye` *through* the rectangle of a quad: an off-axis
 * frustum whose near-plane window is the quad itself. `right`, `up`, `normal` are the quad's
 * axes (normal towards the viewer), `center` its centre; content may reach `front` metres in
 * front of the quad's plane and `back` behind it. Returns `null` for an eye on or behind the plane.
 */
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

const boxX = new THREE.Vector3();
const boxY = new THREE.Vector3();
const boxZ = new THREE.Vector3();
const boxCenter = new THREE.Vector3();
const boxCorner = new THREE.Vector3();
const boxFace = new THREE.Vector3();
const boxEye = new THREE.Vector3();

/**
 * The quad for a group that frames a thin box around a panel (a grab box's outline): it lies in
 * the box's face nearer the head and is a little larger than that face, and each eye's camera
 * looks through it. Unlike a quad turned to the head, **this one never moves while the box does
 * not**: SteamVR is told its place once and holds it. Its picture is exact for the head position
 * it was drawn from and stays within `STEREO_STALE_TOLERANCE` until the head has moved
 * `redrawAfter`, because the box reaches only its own depth behind the quad.
 *
 * The box's place comes from its meshes as the renderer has them now (`instances`, all children
 * of the box's own frame and arranged evenly around its centre), so a box carried by a hand is
 * where fresh tracking puts it. `box` is its size in that frame's units.
 *
 * Returns `null` when the box cannot be seen through such a quad: an eye is too close to the
 * face's plane or behind it, or looks at the box so much from the side that its far edges fall
 * outside the quad. The caller then falls back to the head-facing quad.
 */
export function nativeStereoBoxQuad(
  instances: readonly { worldMatrix: ArrayLike<number> }[],
  box: readonly [number, number, number],
  head: ArrayLike<number>,
  leftEye: ArrayLike<number>,
  rightEye: ArrayLike<number>,
): NativeStereoQuad | null {
  if (instances.length === 0) return null;
  const m = instances[0]!.worldMatrix;
  boxX.set(Number(m[0]), Number(m[1]), Number(m[2]));
  boxY.set(Number(m[4]), Number(m[5]), Number(m[6]));
  boxZ.set(Number(m[8]), Number(m[9]), Number(m[10]));
  const halfWidth = boxX.length() * box[0] / 2;
  const halfHeight = boxY.length() * box[1] / 2;
  const halfDepth = boxZ.length() * box[2] / 2;
  if (!(halfWidth > 1e-6) || !(halfHeight > 1e-6) || !(halfDepth > 0)) return null;
  boxX.normalize();
  boxY.addScaledVector(boxX, -boxY.dot(boxX)).normalize();
  boxZ.crossVectors(boxX, boxY);
  boxCenter.set(0, 0, 0);
  for (const instance of instances) {
    const e = instance.worldMatrix;
    boxCenter.x += Number(e[12]);
    boxCenter.y += Number(e[13]);
    boxCenter.z += Number(e[14]);
  }
  boxCenter.divideScalar(instances.length);

  // The face nearer the head carries the quad; seen from behind, the box is mirrored with it.
  boxEye.set(Number(head[0]), Number(head[1]), Number(head[2])).sub(boxCenter);
  const side = boxEye.dot(boxZ) >= 0 ? 1 : -1;
  boxX.multiplyScalar(side);
  boxZ.multiplyScalar(side);
  boxFace.copy(boxCenter).addScaledVector(boxZ, halfDepth);
  // Room for the far face seen a little from the side, and for the bars' own thickness. All of it
  // in proportion to the box, so a window being resized keeps its quad's shape, and with that
  // its texture's.
  const slideRoom = halfDepth;
  const margin = slideRoom + 0.02 * Math.max(halfWidth, halfHeight);
  const quadHalfWidth = halfWidth + margin;
  const quadHalfHeight = halfHeight + margin;
  const depth = halfDepth * 2;

  let nearest = Infinity;
  for (const eye of [leftEye, rightEye]) {
    boxEye.set(Number(eye[0]), Number(eye[1]), Number(eye[2])).sub(boxFace);
    const distance = boxEye.dot(boxZ);
    // Close to the plane the frustum degenerates; a head-facing quad copes with any position.
    if (!(distance > Math.max(0.08, depth))) return null;
    nearest = Math.min(nearest, distance);
    const ex = boxEye.dot(boxX), ey = boxEye.dot(boxY);
    // The far face's corners, seen through the plane, slide towards the point below the eye.
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

const quadNormal = new THREE.Vector3();
const quadRight = new THREE.Vector3();
const quadUp = new THREE.Vector3();
const quadCenter = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const toCenter = new THREE.Vector3();

/**
 * A quad through `center` facing the head, big enough to frame a sphere of `radius` from either
 * eye, and the two cameras that draw the scene *through that rectangle* (off-axis frusta from
 * each eye's real position). Shown side by side on the quad, each eye sees the group where it
 * really is, while SteamVR keeps the quad itself fixed in the room.
 *
 * Returns `null` while the head is inside the sphere.
 */
export function nativeStereoQuad(
  center: ArrayLike<number>,
  radius: number,
  head: ArrayLike<number>,
  leftEye: ArrayLike<number>,
  rightEye: ArrayLike<number>,
): NativeStereoQuad | null {
  quadCenter.set(Number(center[0]), Number(center[1]), Number(center[2]));
  quadNormal.set(Number(head[0]), Number(head[1]), Number(head[2])).sub(quadCenter);
  const distance = quadNormal.length();
  if (!(distance > radius * 1.05) || !(radius > 0)) return null;
  quadNormal.divideScalar(distance);
  quadRight.crossVectors(worldUp, quadNormal);
  // Looking straight down or up at it: any horizontal direction serves as "right".
  if (quadRight.lengthSq() < 1e-6) quadRight.set(1, 0, 0);
  quadRight.normalize();
  quadUp.crossVectors(quadNormal, quadRight);

  // The sphere's outline on the plane grows as the eye comes closer; each eye also sits to the
  // side of the head centre the quad faces.
  const outline = radius * distance / Math.sqrt(distance * distance - radius * radius);
  const half = Math.min(radius * 4, outline * 1.08 + 0.04 * radius / (distance - radius));

  const eye = (position: ArrayLike<number>) =>
    throughQuad(
      position,
      quadCenter,
      quadRight,
      quadUp,
      quadNormal,
      half,
      half,
      radius * 1.5,
      radius * 1.5,
    );
  const left = eye(leftEye), right = eye(rightEye);
  if (!left || !right) return null;
  const pose = new Float32Array(16);
  cameraScratch.makeBasis(quadRight, quadUp, quadNormal).setPosition(quadCenter).toArray(pose);
  return { pose, width: half * 2, height: half * 2, left, right };
}

const sphereX = new THREE.Vector3();
const sphereCenter = new THREE.Vector3();

/** The sphere around a box group as the renderer has it now, for the head-facing fallback quad. */
export function nativeStereoBoxSphere(
  instances: readonly { worldMatrix: ArrayLike<number> }[],
  box: readonly [number, number, number],
): { center: [number, number, number]; radius: number } | null {
  if (instances.length === 0) return null;
  const m = instances[0]!.worldMatrix;
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    sphereX.set(Number(m[axis * 4]), Number(m[axis * 4 + 1]), Number(m[axis * 4 + 2]));
    squared += (sphereX.length() * box[axis]! / 2) ** 2;
  }
  sphereCenter.set(0, 0, 0);
  for (const instance of instances) {
    const e = instance.worldMatrix;
    sphereCenter.x += Number(e[12]);
    sphereCenter.y += Number(e[13]);
    sphereCenter.z += Number(e[14]);
  }
  sphereCenter.divideScalar(instances.length);
  // A little more than the corners' distance: the bars have thickness.
  return { center: sphereCenter.toArray(), radius: Math.sqrt(squared) + 0.01 };
}

const stereoLocal = new THREE.Matrix4();
const stereoInverse = new THREE.Matrix4();

/**
 * Hash of what a stereo group draws, placed relative to its quad: which meshes, which materials,
 * where. With the head's own movement (`NativeStereoQuad.redrawAfter`) and the scene's asset
 * version (a material that changed colour keeps its id) it decides when the group's picture has
 * to be drawn again.
 */
export function nativeStereoContentHash(
  instances: NativeStereoPlan["instances"],
  quadPose: ArrayLike<number>,
): number {
  let state = 0x811c9dc5;
  const word = (w: number) => {
    state = Math.imul(state ^ w, 0x01000193);
  };
  stereoInverse.fromArray(quadPose as number[]).invert();
  word(instances.length);
  for (const instance of instances) {
    word(Number(instance.geometryId) | 0);
    word(Number(instance.materialId) | 0);
    stereoLocal.fromArray(instance.worldMatrix as unknown as number[]).premultiply(stereoInverse);
    const e = stereoLocal.elements;
    for (let i = 0; i < 16; i++) word(Math.round(e[i]! * 1e5) | 0);
  }
  return state >>> 0;
}

const hashFloat = new Float32Array(1);
const hashBits = new Uint32Array(hashFloat.buffer);
const hashLocal = new THREE.Matrix4();
const hashInverse = new THREE.Matrix4();
const hashAnchorInverse = new THREE.Matrix4();

/**
 * Hash of a panel's picture: everything drawn on it, placed relative to the panel. Moving the
 * panel through the room does not change it, so a carried window is not redrawn every frame.
 *
 * Items that ride the same tracked space as the panel (a wrist menu on its hand, a window in a
 * grab) are placed by their anchors' local matrices: those stay bit-identical while the hand
 * moves, where world matrices rebuilt from tracking every frame carry float noise that would
 * redraw the panel constantly. Positions are still rounded, to a hundred-thousandth of the
 * panel's size, well below a texel.
 */
export function nativePanelContentHash(plan: NativePanelPlan, camera: NativePanelCamera): number {
  let state = 0x811c9dc5;
  const word = (w: number) => {
    state = Math.imul(state ^ w, 0x01000193);
  };
  const float = (value: number) => {
    hashFloat[0] = value;
    word(hashBits[0]!);
  };
  const floats = (values: ArrayLike<number> | undefined, count: number) => {
    if (!values) return word(1);
    for (let i = 0; i < count; i++) float(Number(values[i] ?? 0));
  };
  const string = (value: string | undefined) => {
    if (value === undefined) return word(2);
    word(value.length);
    for (let i = 0; i < value.length; i++) word(value.charCodeAt(i));
  };
  hashInverse.fromArray(camera.viewMatrix as unknown as number[]);
  const panelAnchor = plan.panel.renderAnchor;
  const anchored = panelAnchor != null && panelFrame(panelAnchor.localMatrix, hashAnchorInverse);
  if (anchored) hashAnchorInverse.invert();
  const placement = (
    item: { worldMatrix: ArrayLike<number>; renderAnchor?: typeof panelAnchor },
  ) => {
    const anchor = item.renderAnchor;
    if (
      anchored && anchor != null && anchor.space === panelAnchor!.space &&
      anchor.follow === panelAnchor!.follow && anchor.pair === panelAnchor!.pair
    ) {
      hashLocal.fromArray(anchor.localMatrix as unknown as number[]).premultiply(hashAnchorInverse);
    } else {
      hashLocal.fromArray(item.worldMatrix as number[]).premultiply(hashInverse);
    }
    const e = hashLocal.elements;
    for (let i = 0; i < 16; i++) word(Math.round(e[i]! * 1e5) | 0);
  };

  word(camera.textureWidth);
  word(camera.textureHeight);
  const rendering = plan.ui.textRendering as Record<string, unknown> | undefined;
  if (rendering) {
    for (const key in rendering) {
      string(key);
      string(String(rendering[key]));
    }
  }
  word(plan.ui.panels.length);
  for (const panel of plan.ui.panels) {
    placement(panel);
    floats(panel.data, 16);
    word(panel.instanceIndex | 0);
    word(panel.renderOrder | 0);
    const order = panel.orderInfo;
    if (order) {
      word(order.majorIndex | 0);
      word(order.minorIndex | 0);
      word(order.elementType | 0);
      word(order.patchIndex | 0);
    }
  }
  word(plan.ui.texts.length);
  for (const text of plan.ui.texts) {
    placement(text);
    string(text.text);
    floats(text.color, 4);
    float(text.fontSize);
    string(text.font);
    const geometry = text.geometry;
    if (geometry) {
      word((geometry.id ?? 0) | 0);
      word((geometry.revision ?? geometry.version ?? 0) | 0);
    } else word(3);
  }
  word(plan.ui.images.length);
  for (const image of plan.ui.images) {
    placement(image);
    string(image.texture);
    float(image.width);
    float(image.height);
    float(image.opacity ?? 1);
    string(image.fit);
    floats(image.focus, 2);
    floats(image.borderRadius, 4);
  }
  return state >>> 0;
}
