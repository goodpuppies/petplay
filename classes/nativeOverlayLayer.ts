/**
 * One frame of native overlays in the renderer process (`docs/NATIVE_OVERLAYS.md`): draws each
 * planned panel into its own texture when its picture changed, draws each stereo group for both
 * eyes, and hands the results to SteamVR as quads. Runs right after the eye image of the same
 * frame, on the renderer's GL thread.
 */
import * as THREE from "three";
import {
  type NativeContentPlan,
  nativeMeshQuad,
  type NativeOverlayDevice,
  nativePanelAttachment,
  nativePanelCamera,
  nativePanelContentHash,
  nativeStereoBoxQuad,
  nativeStereoBoxSphere,
  nativeStereoContentHash,
  nativeStereoQuad,
  nativeTextureSize,
} from "./nativeOverlayMath.ts";
import { OpenVrNativeOverlays, type StereoSizing } from "./openVrNativeOverlays.ts";
import type { Anchored, RenderAnchorSpace } from "./overlayRenderTracking.ts";
import type { WebXROverlayRaylib } from "./webxrOverlayRaylib.ts";

export type { NativeOverlayDevice };

const NONE: ReadonlySet<string> = new Set();

export class NativeOverlayLayer {
  private readonly overlays: OpenVrNativeOverlays;
  /** Content hash of the picture each panel's quad shows. */
  private readonly pictures = new Map<string, number>();
  /** What each stereo quad's picture was drawn from, to tell when it is worth drawing again. */
  private readonly stereoPictures = new Map<string, {
    hash: number;
    assetVersion: number;
    /** Both eyes' positions in the quad's own frame. */
    eyes: Float64Array;
    eyeWidth: number;
    eyeHeight: number;
  }>();
  /** What each plain quad's picture was drawn from (mesh, material, asset version), and how wide. */
  private readonly meshPictures = new Map<string, { content: string; textureWidth: number }>();
  private readonly quadInverse = new THREE.Matrix4();
  private readonly eyeInQuad = new THREE.Vector3();
  private readonly eyesInQuad = new Float64Array(6);
  private targetGeneration = -1;
  private readonly eyePose = new THREE.Matrix4();
  private readonly leftEye = new Float64Array(3);
  private readonly rightEye = new Float64Array(3);
  /** Texture texels per uikit pixel of a panel. */
  texelsPerPixel = 2;
  /** Per-eye size of the texture of a stereo group shown on a head-facing quad. */
  stereoEyeSize = 1024;
  /** Texels per metre of a box outline's texture: about the eye image's own density at 1 m. */
  stereoTexelsPerMeter = 1500;
  /**
   * Sort order of the pointer's quads (laser beams; cursor dots one above): over the panels (0)
   * and the head-locked image (1). 0 puts them among the panels, by distance.
   */
  pointerSortOrder = 2;
  /** Counters for the health readout. */
  readonly stats = {
    panels: 0,
    stereo: 0,
    pointer: 0,
    panelRedraws: 0,
    stereoRedraws: 0,
    pointerRedraws: 0,
    frames: 0,
  };

  constructor(overlayPointer: Deno.PointerValue, keyPrefix: string, namePrefix: string) {
    this.overlays = new OpenVrNativeOverlays(overlayPointer, keyPrefix, namePrefix);
  }

  set stereoTexelAspect(value: number | null) {
    this.overlays.stereoTexelAspect = value;
  }

  /** Frames a quad that left the scene keeps its SteamVR overlay and its picture, hidden. */
  set unusedFramesBeforeParking(frames: number) {
    this.overlays.unusedFramesBeforeParking = frames;
  }

  /** How SteamVR is taken to size side-by-side quads; see `StereoSizing`. */
  set stereoSizing(value: StereoSizing) {
    this.overlays.stereoSizing = value;
  }

  status() {
    return {
      ...this.stats,
      /** SteamVR overlays kept for their texture size, with no quad to show. */
      spareOverlays: this.overlays.spare,
      /** Overlays SteamVR turned out to hold at another texture size; see openVrNativeOverlays.ts. */
      sizeMismatches: this.overlays.mismatches,
      overlays: this.overlays.status(),
    };
  }

  /** Keys of the quads SteamVR holds, hidden ones included. */
  overlayKeys(): string[] {
    return [...this.overlays.keys()];
  }

  /** The SteamVR overlay behind a quad, for looking at it from outside. */
  overlayHandle(key: string): bigint | null {
    return this.overlays.handleOf(key);
  }

  /**
   * `plan` is this frame's native content, or `null` for none (every quad is then removed).
   * `head` and the eye view matrices are the ones the eye image was just rendered with.
   */
  present(
    plan: NativeContentPlan | null,
    renderer: WebXROverlayRaylib,
    view: {
      head: ArrayLike<number>;
      leftEyeViewMatrix: ArrayLike<number>;
      rightEyeViewMatrix: ArrayLike<number>;
      /** The tracked device behind each anchor space, where it is tracked. */
      devices?: Partial<Record<RenderAnchorSpace, NativeOverlayDevice>>;
      /** Follow keys of released grabs held at their last pose: no longer riding the hand. */
      heldFollows?: { has(key: string): boolean };
      /** Advances when a mesh or material of the scene changed (a colour, say) under its id. */
      assetVersion?: number;
    },
  ): void {
    if (!plan) {
      // Nothing native in the scene: what is left is hidden now and let go a little later.
      if (this.overlays.count > 0 || this.pictures.size > 0) this.retain(NONE, renderer);
      this.stats.panels = this.stats.stereo = this.stats.pointer = 0;
      return;
    }
    if (renderer.nativeTargetGeneration !== this.targetGeneration) {
      // The renderer rebuilt its targets: every picture has to be drawn again.
      this.pictures.clear();
      this.stereoPictures.clear();
      this.meshPictures.clear();
      this.targetGeneration = renderer.nativeTargetGeneration;
    }
    const keep = new Set<string>();
    for (const item of plan.panels) {
      const key = `panel.${item.panel.key}`;
      if (keep.has(key)) continue;
      const camera = nativePanelCamera(item.panel, this.texelsPerPixel);
      if (!camera) continue;
      keep.add(key);
      const hash = nativePanelContentHash(item, camera);
      let texture: { id: number; width: number; height: number } | undefined;
      if (this.pictures.get(key) !== hash) {
        texture = {
          id: renderer.renderNativePanel(key, item.ui, camera),
          width: camera.textureWidth,
          height: camera.textureHeight,
        };
        this.pictures.set(key, hash);
        this.stats.panelRedraws++;
      }
      this.overlays.present({
        key,
        pose: camera.pose,
        device: nativePanelAttachment(
          item.panel.renderAnchor,
          camera.pose,
          view.devices,
          view.heldFollows,
        ) ?? undefined,
        widthMeters: camera.widthMeters,
        texelAspect: camera.texelAspect,
        texture,
      });
    }
    let stereo = 0;
    if (plan.stereo.length > 0) {
      this.eyePosition(view.leftEyeViewMatrix, this.leftEye);
      this.eyePosition(view.rightEyeViewMatrix, this.rightEye);
      const head = [Number(view.head[12]), Number(view.head[13]), Number(view.head[14])];
      const assetVersion = view.assetVersion ?? 0;
      for (const group of plan.stereo) {
        const key = `stereo.${group.key}`;
        if (keep.has(key)) continue;
        // A box outline sits on a quad in its own nearer face, which SteamVR can hold still; seen
        // too much from the side, or with no box at all, the quad turns to the head instead.
        let quad = group.box
          ? nativeStereoBoxQuad(group.instances, group.box, head, this.leftEye, this.rightEye)
          : null;
        if (!quad) {
          const sphere = group.box ? nativeStereoBoxSphere(group.instances, group.box) : null;
          quad = nativeStereoQuad(
            sphere?.center ?? group.center,
            sphere?.radius ?? group.radius,
            head,
            this.leftEye,
            this.rightEye,
          );
        }
        // Head inside the group: there is no rectangle to look through.
        if (!quad) continue;
        keep.add(key);
        stereo++;
        const fixed = quad.redrawAfter != null;
        // In steps, each way on its own: every texture size in use costs a SteamVR overlay, and
        // a window being resized would otherwise pass through hundreds.
        const eyeWidth = fixed
          ? nativeTextureSize(quad.width * this.stereoTexelsPerMeter, 2048)
          : this.stereoEyeSize;
        const eyeHeight = fixed
          ? nativeTextureSize(quad.height * this.stereoTexelsPerMeter, 2048)
          : this.stereoEyeSize;

        // Draw again only when it would show: the content changed, or the eyes have moved far
        // enough in the quad's frame for what lies off its plane to shift. A quad that turns to
        // the head has a new frame, and so a new picture, every time.
        this.quadInverse.fromArray(quad.pose as unknown as number[]).invert();
        const eyes = this.eyesInQuad;
        this.eyeInQuad.fromArray(this.leftEye).applyMatrix4(this.quadInverse).toArray(eyes, 0);
        this.eyeInQuad.fromArray(this.rightEye).applyMatrix4(this.quadInverse).toArray(eyes, 3);
        const hash = nativeStereoContentHash(group.instances, quad.pose);
        const drawn = this.stereoPictures.get(key);
        let texture: { id: number; width: number; height: number } | undefined;
        if (
          !fixed || !drawn || drawn.hash !== hash || drawn.assetVersion !== assetVersion ||
          drawn.eyeWidth !== eyeWidth || drawn.eyeHeight !== eyeHeight ||
          Math.hypot(
              eyes[0]! - drawn.eyes[0]!,
              eyes[1]! - drawn.eyes[1]!,
              eyes[2]! - drawn.eyes[2]!,
            ) >
            quad.redrawAfter! ||
          Math.hypot(
              eyes[3]! - drawn.eyes[3]!,
              eyes[4]! - drawn.eyes[4]!,
              eyes[5]! - drawn.eyes[5]!,
            ) >
            quad.redrawAfter!
        ) {
          texture = {
            id: renderer.renderNativeStereo(
              key,
              plan.eyePayload.leftEye,
              group.instances,
              quad,
              eyeWidth,
              eyeHeight,
              // Panel backgrounds hide the bars behind them, as they do in the eye image.
              group.box ? plan.eyePayload.ui.depthOnlyPanels : undefined,
            ),
            width: eyeWidth * 2,
            height: eyeHeight,
          };
          this.stereoPictures.set(key, {
            hash,
            assetVersion,
            eyes: eyes.slice(),
            eyeWidth,
            eyeHeight,
          });
          this.stats.stereoRedraws++;
        }
        this.overlays.present({
          key,
          pose: quad.pose,
          // A box carried by a hand rides that hand's device, like the panel inside it.
          device: fixed
            ? nativePanelAttachment(
              (group.instances[0] as Anchored | undefined)?.renderAnchor,
              quad.pose,
              view.devices,
              view.heldFollows,
            ) ?? undefined
            : undefined,
          widthMeters: quad.width,
          // One eye's picture fills the quad whatever its texture's shape.
          texelAspect: (quad.width / eyeWidth) / (quad.height / eyeHeight),
          texture,
          stereo: true,
        });
      }
    }
    // Laser beams and cursor dots: one plain quad each. A beam's picture is the same whatever
    // its length, a dot's whatever its size, so they are drawn once and then only placed.
    let pointer = 0;
    for (const item of plan.quads) {
      const key = `quad.${item.key}`;
      if (keep.has(key)) continue;
      const drawn = this.meshPictures.get(key);
      const quad = nativeMeshQuad(
        item.instance.worldMatrix,
        item.shape,
        item.extent,
        [Number(view.head[12]), Number(view.head[13]), Number(view.head[14])],
        drawn?.textureWidth,
      );
      if (!quad) continue;
      keep.add(key);
      pointer++;
      const content = `${item.shape}:${item.instance.geometryId}:${item.instance.materialId}:${
        view.assetVersion ?? 0
      }`;
      let texture: { id: number; width: number; height: number } | undefined;
      if (drawn?.content !== content || drawn.textureWidth !== quad.textureWidth) {
        texture = {
          id: renderer.renderNativeMesh(
            key,
            plan.eyePayload.leftEye,
            [item.instance],
            quad,
            quad.textureWidth,
            quad.textureHeight,
          ),
          width: quad.textureWidth,
          height: quad.textureHeight,
        };
        this.meshPictures.set(key, { content, textureWidth: quad.textureWidth });
        this.stats.pointerRedraws++;
      }
      const raised = this.pointerSortOrder > 0;
      this.overlays.present({
        key,
        pose: quad.pose,
        // A beam in a hand's ray space rides that controller: SteamVR moves it with the hand.
        device: nativePanelAttachment(
          (item.instance as Anchored).renderAnchor,
          quad.pose,
          view.devices,
          view.heldFollows,
        ) ?? undefined,
        widthMeters: quad.width,
        texelAspect: quad.texelAspect,
        texture,
        sortOrder: this.pointerSortOrder + (raised && item.shape === "flat" ? 1 : 0),
      });
    }
    this.retain(keep, renderer);
    this.stats.panels = keep.size - stereo - pointer;
    this.stats.stereo = stereo;
    this.stats.pointer = pointer;
    this.stats.frames++;
  }

  /**
   * Quads not in `keep` are hidden; SteamVR holds them and their pictures a while longer, so the
   * textures and content hashes behind them stay until the quads themselves are let go.
   */
  private retain(keep: ReadonlySet<string>, renderer: WebXROverlayRaylib): void {
    this.overlays.retain(keep);
    const held = this.overlays.keys();
    renderer.retainNativeTargets(held);
    for (const key of this.pictures.keys()) if (!held.has(key)) this.pictures.delete(key);
    for (const key of this.stereoPictures.keys()) {
      if (!held.has(key)) this.stereoPictures.delete(key);
    }
    for (const key of this.meshPictures.keys()) if (!held.has(key)) this.meshPictures.delete(key);
  }

  /** Remove every quad and its texture. Safe to call when SteamVR is already going away. */
  clear(renderer: WebXROverlayRaylib | null): void {
    try {
      this.overlays.cleanup();
    } catch (error) {
      console.warn("[native-overlays] cleanup:", error);
    }
    this.pictures.clear();
    this.stereoPictures.clear();
    this.meshPictures.clear();
    try {
      renderer?.retainNativeTargets(NONE);
    } catch (error) {
      console.warn("[native-overlays] texture cleanup:", error);
    }
  }

  private eyePosition(viewMatrix: ArrayLike<number>, target: Float64Array): void {
    const e = this.eyePose.fromArray(viewMatrix as number[]).invert().elements;
    target[0] = e[12]!;
    target[1] = e[13]!;
    target[2] = e[14]!;
  }
}
