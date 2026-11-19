/// <reference lib="dom" />
/**
 * Browser renderer for PetPlay's scene stream (markdown/scene-stream, P4).
 *
 * A replica `SceneStore` receives binary deltas over a WebSocket and acks each one; a listener
 * on the replica keeps a three.js scene in step with exactly the rows that changed. Tracked nodes
 * (head, hands) take their poses from the separate pose messages.
 *
 * Input follows `viewControls.ts`: navigation stays here, everything else is sent to the scene's
 * pmndrs pointer events together with the camera this view drew, so the server picks exactly
 * what the user sees.
 */
import * as THREE from "npm:three@0.186.1";
import { dragAction, ViewCameraController, wheelNavigates } from "./viewControls.ts";
import {
  decodeDelta,
  type GeometryData,
  type LightData,
  type MaterialModel,
  type MaterialState,
  type MeshItemData,
  type NodeStructure,
  type Placement,
  type RowId,
  SceneStore,
  StoreDivergence,
  type TextRunData,
  type TextureMeta,
  type TextureSource,
  type TouchedRow,
  type TrackedPair,
  type TrackedSpace,
  type UiOrder,
  type UiQuadData,
  WORLD_NODE,
} from "../../submodules/raythree/src/store/mod.ts";

// ---- three.js scene mirroring the replica ----

const UI_RENDER_ORDER_BASE = 1000;
const OVERLAY_RENDER_ORDER = 1_000_000;

type UiEntry = { object: THREE.Mesh; order: UiOrder };

class SceneView {
  readonly scene = new THREE.Scene();
  private readonly textures = new Map<RowId, THREE.Texture>();
  private readonly geometries = new Map<RowId, THREE.BufferGeometry>();
  private readonly materials = new Map<RowId, THREE.Material>();
  private readonly nodes = new Map<RowId, THREE.Object3D>();
  private readonly lights = new Map<RowId, THREE.Light>();
  private readonly items = new Map<RowId, THREE.Object3D>();
  private readonly ui = new Map<RowId, UiEntry>();
  private readonly tracked = new Map<RowId, TrackedSpace | TrackedPair>();
  private poses: Partial<Record<TrackedSpace, THREE.Matrix4>> = {};
  private readonly quadGeometry = new THREE.PlaneGeometry(1, 1);

  constructor(private readonly store: SceneStore) {
    this.scene.background = new THREE.Color(0x15171c);
    const world = new THREE.Group();
    world.matrixAutoUpdate = false;
    this.nodes.set(WORLD_NODE, world);
    this.scene.add(world);
    store.onTransaction((touched) => this.sync(touched));
  }

  setPoses(poses: Partial<Record<TrackedSpace, number[]>>): void {
    this.poses = {};
    for (const [space, m] of Object.entries(poses)) {
      if (m) this.poses[space as TrackedSpace] = new THREE.Matrix4().fromArray(m);
    }
  }

  pose(space: TrackedSpace): THREE.Matrix4 | undefined {
    return this.poses[space];
  }

  /** Per frame: tracked node poses, then the UI draw order for this camera. */
  update(camera: THREE.Camera): void {
    for (const [id, tracked] of this.tracked) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const pose = typeof tracked === "string" ? this.poses[tracked] : pairFrame(this.poses, tracked);
      node.visible = pose != null;
      if (pose) node.matrix.copy(pose);
    }
    this.scene.updateMatrixWorld(true);
    this.sortUi(camera);
  }

  // Rows arrive in dependency order (assets before items) within each transaction.
  private sync(touched: TouchedRow[]): void {
    for (const row of touched) {
      try {
        switch (row.table) {
          case "textures":
            this.syncTexture(row);
            break;
          case "geometries":
            this.syncGeometry(row);
            break;
          case "materials":
            this.syncMaterial(row);
            break;
          case "nodes":
            this.syncNode(row);
            break;
          case "lights":
            this.syncLight(row);
            break;
          case "items":
            this.syncItem(row);
            break;
        }
      } catch (error) {
        console.error(`scene-stream: ${row.table} ${row.id}`, error);
      }
    }
  }

  private syncTexture(row: TouchedRow): void {
    const old = this.textures.get(row.id);
    if (row.removed) {
      old?.dispose();
      this.textures.delete(row.id);
      return;
    }
    const { meta, source } = this.store.get("textures", row.id)! as { meta: TextureMeta; source: TextureSource };
    // Keep the texture object: materials hold it, and the pixels arrive asynchronously.
    const texture = old ?? new THREE.Texture();
    this.textures.set(row.id, texture);
    // Sampled raw: UI shaders write sRGB values straight to the sRGB framebuffer, as raylib does.
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false; // applied at decode, below
    texture.generateMipmaps = meta.generateMipmaps;
    texture.minFilter = meta.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.wrapS = wrap(meta.wrapS);
    texture.wrapT = wrap(meta.wrapT);
    if (source.bytes) {
      const blob = new Blob([source.bytes as Uint8Array<ArrayBuffer>], { type: source.mimeType ?? "image/png" });
      // WebGL ignores Texture.flipY for ImageBitmaps: the flip has to happen at decode.
      createImageBitmap(blob, {
        imageOrientation: meta.flipY ? "flipY" : "none",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      })
        .then((bitmap) => {
          texture.image = bitmap;
          texture.needsUpdate = true;
        })
        .catch((error) => console.error(`scene-stream: texture ${row.id}`, error));
    }
  }

  private syncGeometry(row: TouchedRow): void {
    this.geometries.get(row.id)?.dispose();
    if (row.removed) {
      this.geometries.delete(row.id);
      return;
    }
    const { data } = this.store.get("geometries", row.id)! as { data: GeometryData };
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(data.attributes)) {
      geometry.setAttribute(
        name,
        new THREE.BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized),
      );
    }
    if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    this.geometries.set(row.id, geometry);
    // Items keep their geometry by reference: rebind the ones using this row.
    this.rebindItems((d) => d.geometry === row.id);
  }

  private syncMaterial(row: TouchedRow): void {
    this.materials.get(row.id)?.dispose();
    if (row.removed) {
      this.materials.delete(row.id);
      return;
    }
    const { model, state } = this.store.get("materials", row.id)! as { model: MaterialModel; state: MaterialState };
    const color = new THREE.Color().setRGB(model.baseColor[0], model.baseColor[1], model.baseColor[2], THREE.SRGBColorSpace);
    const common = {
      color,
      opacity: model.baseColor[3],
      transparent: state.blend !== "opaque" || model.baseColor[3] < 1,
      depthTest: state.depthTest,
      depthWrite: state.depthWrite,
      colorWrite: state.colorWrite,
      wireframe: state.wireframe,
      vertexColors: model.vertexColors,
      side: state.cull === "none" ? THREE.DoubleSide : state.cull === "front" ? THREE.BackSide : THREE.FrontSide,
      blending: state.blend === "add" ? THREE.AdditiveBlending : state.blend === "multiply" ? THREE.MultiplyBlending : THREE.NormalBlending,
    };
    const material = (model.model === "pbr" || model.fallback === "pbr")
      ? new THREE.MeshStandardMaterial({
        ...common,
        roughness: model.roughness ?? 1,
        metalness: model.metalness ?? 0,
        emissive: model.emissive
          ? new THREE.Color().setRGB(...model.emissive, THREE.SRGBColorSpace)
          : undefined,
      })
      : new THREE.MeshBasicMaterial(common);
    const map = model.textures.find((t) => t.slot === "map");
    if (map) (material as THREE.MeshBasicMaterial).map = this.textures.get(map.texture) ?? null;
    this.materials.set(row.id, material);
    this.rebindItems((d) => d.material === row.id);
  }

  private syncNode(row: TouchedRow): void {
    if (row.id === WORLD_NODE) return;
    let node = this.nodes.get(row.id);
    if (row.removed) {
      node?.removeFromParent();
      this.nodes.delete(row.id);
      this.tracked.delete(row.id);
      return;
    }
    const { structure, transform } = this.store.get("nodes", row.id)! as { structure: NodeStructure; transform: Float64Array };
    if (!node) {
      node = new THREE.Group();
      node.matrixAutoUpdate = false;
      this.nodes.set(row.id, node);
    }
    (this.nodes.get(structure.parent ?? WORLD_NODE) ?? this.nodes.get(WORLD_NODE)!).add(node);
    if (structure.tracked) {
      this.tracked.set(row.id, structure.tracked);
      node.visible = false; // until its pose arrives
    } else {
      this.tracked.delete(row.id);
      node.matrix.fromArray(transform);
    }
  }

  private syncLight(row: TouchedRow): void {
    this.lights.get(row.id)?.removeFromParent();
    if (row.removed) {
      this.lights.delete(row.id);
      return;
    }
    const { light, placement } = this.store.get("lights", row.id)! as { light: LightData; placement: Placement };
    const color = new THREE.Color().setRGB(...light.color);
    const object = light.type === "ambient"
      ? new THREE.AmbientLight(color, light.intensity)
      : light.type === "directional"
      ? new THREE.DirectionalLight(color, light.intensity)
      : light.type === "spot"
      ? new THREE.SpotLight(color, light.intensity, light.range ?? 0, light.outerConeAngle ?? Math.PI / 3)
      : new THREE.PointLight(color, light.intensity, light.range ?? 0, light.decay ?? 2);
    object.matrixAutoUpdate = false;
    object.matrix.fromArray(placement.matrix);
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight) {
      // glTF: the light shines down its local -Z.
      object.target.position.set(0, 0, -1);
      object.add(object.target);
    }
    this.nodes.get(placement.node)?.add(object);
    this.lights.set(row.id, object);
  }

  private syncItem(row: TouchedRow): void {
    const old = this.items.get(row.id);
    if (row.removed) {
      this.disposeItem(row.id, old);
      return;
    }
    const item = this.store.get("items", row.id)!;
    // A transform-only change moves the existing object.
    if (old && row.mask === 1 << 1 && old.parent === this.nodes.get(item.header.node)) {
      old.matrix.fromArray(item.transform);
      this.setUiItemMatrix(row.id, item.transform);
      return;
    }
    this.disposeItem(row.id, old);
    const object = this.buildItem(row.id, item.header.kind, item.data);
    if (!object) return;
    object.matrixAutoUpdate = false;
    object.matrix.fromArray(item.transform);
    object.visible = item.state.visible;
    this.setUiItemMatrix(row.id, item.transform);
    if (!this.ui.has(row.id)) {
      object.renderOrder = (item.data as MeshItemData).overlay ? OVERLAY_RENDER_ORDER : item.state.order;
    }
    (this.nodes.get(item.header.node) ?? this.nodes.get(WORLD_NODE)!).add(object);
    this.items.set(row.id, object);
  }

  private buildItem(id: RowId, kind: string, data: unknown): THREE.Object3D | null {
    switch (kind) {
      case "mesh":
      case "instancedMesh": {
        const d = data as MeshItemData;
        const geometry = this.geometries.get(d.geometry);
        const material = this.materials.get(d.material);
        if (!geometry || !material) return null;
        if (kind === "mesh" || !d.instances) return new THREE.Mesh(geometry, material);
        const mesh = new THREE.InstancedMesh(geometry, material, d.instanceCount);
        const m = new THREE.Matrix4();
        for (let i = 0; i < d.instanceCount; i++) mesh.setMatrixAt(i, m.fromArray(d.instances, i * 16));
        return mesh;
      }
      case "uiQuad": {
        const d = data as UiQuadData;
        const mesh = new THREE.Mesh(this.quadGeometry, uiQuadMaterial(d, d.image ? this.textures.get(d.image.texture) ?? null : null));
        this.ui.set(id, { object: mesh, order: d.uiOrder });
        return mesh;
      }
      case "textRun": {
        const d = data as TextRunData;
        const atlas = this.textures.get(d.atlas);
        if (!atlas) return null;
        const mesh = new THREE.Mesh(glyphGeometry(d.glyphs), msdfMaterial(d, atlas));
        this.ui.set(id, { object: mesh, order: d.uiOrder });
        return mesh;
      }
    }
    console.warn(`scene-stream: unknown item kind ${kind}`);
    return null;
  }

  /** UI clip planes are in node space: the shader needs the item's own transform. */
  private setUiItemMatrix(id: RowId, transform: Float64Array): void {
    const material = this.ui.get(id)?.object.material as THREE.ShaderMaterial | undefined;
    material?.uniforms.uItem?.value.fromArray(transform);
  }

  private disposeItem(id: RowId, object: THREE.Object3D | undefined): void {
    if (!object) return;
    object.removeFromParent();
    if (this.ui.has(id) && object instanceof THREE.Mesh) {
      (object.material as THREE.Material).dispose();
      if (object.geometry !== this.quadGeometry) object.geometry.dispose();
    }
    this.ui.delete(id);
    this.items.delete(id);
  }

  /** Rebuilds the mesh items whose data matches (after an asset they use changed). */
  private rebindItems(uses: (data: MeshItemData) => boolean): void {
    for (const id of [...this.items.keys()]) {
      const item = this.store.get("items", id);
      if (!item || (item.header.kind !== "mesh" && item.header.kind !== "instancedMesh")) continue;
      if (uses(item.data as MeshItemData)) this.syncItem({ table: "items", id, mask: 0b1111, removed: false });
    }
  }

  /**
   * UI draws without depth testing, in an explicit order: roots back to front by view depth,
   * then each root's own order. Text sorts back to front within its layer.
   */
  private sortUi(camera: THREE.Camera): void {
    const viewZ = (object: THREE.Object3D) =>
      new THREE.Vector3().setFromMatrixPosition(object.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
    const roots = new Map<number, { z: number; n: number }>();
    const entries = [...this.ui.values()].filter((e) => e.object.parent && e.object.visible);
    const depth = new Map<UiEntry, number>();
    for (const entry of entries) {
      const z = viewZ(entry.object);
      depth.set(entry, z);
      const r = roots.get(entry.order[0]) ?? { z: 0, n: 0 };
      r.z += z;
      r.n++;
      roots.set(entry.order[0], r);
    }
    // View space looks down -Z: more negative is farther, drawn first.
    const rootRank = new Map(
      [...roots.entries()].sort((a, b) => a[1].z / a[1].n - b[1].z / b[1].n).map(([root], i) => [root, i]),
    );
    entries.sort((a, b) => {
      const ra = rootRank.get(a.order[0])!, rb = rootRank.get(b.order[0])!;
      if (ra !== rb) return ra - rb;
      for (let k = 1; k < 8; k++) if (a.order[k] !== b.order[k]) return a.order[k]! - b.order[k]!;
      return a.order[1] === 1 ? depth.get(a)! - depth.get(b)! : 0;
    });
    entries.forEach((entry, i) => entry.object.renderOrder = UI_RENDER_ORDER_BASE + i);
  }
}

function wrap(mode: TextureMeta["wrapS"]): THREE.Wrapping {
  return mode === "repeat" ? THREE.RepeatWrapping : mode === "mirror" ? THREE.MirroredRepeatWrapping : THREE.ClampToEdgeWrapping;
}

/** The two-hand carry frame: as PetPlay's `followFrame`. */
function pairFrame(poses: Partial<Record<TrackedSpace, THREE.Matrix4>>, pair: TrackedPair): THREE.Matrix4 | undefined {
  const a = poses[pair.first], b = poses[pair.second];
  if (!a || !b) return undefined;
  const pa = new THREE.Vector3().fromArray(pair.points[0]).applyMatrix4(a);
  const pb = new THREE.Vector3().fromArray(pair.points[1]).applyMatrix4(b);
  const x = pb.clone().sub(pa);
  const distance = x.length();
  if (distance < 1e-6) return undefined;
  x.divideScalar(distance);
  const y = new THREE.Vector3(0, 1, 0).transformDirection(a).add(new THREE.Vector3(0, 1, 0).transformDirection(b));
  y.addScaledVector(x, -y.dot(x));
  if (y.lengthSq() < 1e-8) y.set(0, 0, 1).addScaledVector(x, -x.z);
  y.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).scale(new THREE.Vector3(distance, distance, distance))
    .setPosition(pa.add(pb).multiplyScalar(0.5));
}

// ---- UI materials ----

const CLIP_GLSL = /* glsl */ `
uniform bool uHasClip;
uniform vec4 uClip[4];
varying vec3 vNode;
void applyClip() {
  if (!uHasClip) return;
  for (int i = 0; i < 4; i++) {
    if (dot(uClip[i].xyz, vNode) + uClip[i].w <= 0.0) discard;
  }
}`;

function clipUniforms(clip: Float64Array | null) {
  const planes = [0, 1, 2, 3].map((i) =>
    clip ? new THREE.Vector4(clip[i * 4]!, clip[i * 4 + 1]!, clip[i * 4 + 2]!, clip[i * 4 + 3]!) : new THREE.Vector4()
  );
  return { uHasClip: { value: clip != null }, uClip: { value: planes }, uItem: { value: new THREE.Matrix4() } };
}

/** Rounded rectangle with border and flat or image fill; sRGB in, sRGB out (no conversion). */
function uiQuadMaterial(d: UiQuadData, image: THREE.Texture | null): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uSize: { value: new THREE.Vector2(...d.size) },
      uBorder: { value: new THREE.Vector4(...d.borderWidth) },
      uRadius: { value: new THREE.Vector4(...d.borderRadius) },
      uBackground: { value: new THREE.Vector4(...d.background) },
      uBorderColor: { value: new THREE.Vector4(...d.border) },
      uHasImage: { value: image != null },
      uImage: { value: image },
      uImageOpacity: { value: d.image?.opacity ?? 1 },
      uCover: { value: d.image?.fit !== "stretch" },
      uFocus: { value: new THREE.Vector2(...(d.image?.focus ?? [0.5, 0.5])) },
      uImageSize: { value: new THREE.Vector2(1, 1) },
      ...clipUniforms(d.clip),
    },
    vertexShader: /* glsl */ `
      uniform mat4 uItem;
      varying vec2 vUv;
      varying vec3 vNode;
      void main() {
        vUv = uv;
        vNode = (uItem * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uSize;
      uniform vec4 uBorder;      // top, right, bottom, left
      uniform vec4 uRadius;      // top-left, top-right, bottom-right, bottom-left
      uniform vec4 uBackground;
      uniform vec4 uBorderColor;
      uniform bool uHasImage;
      uniform sampler2D uImage;
      uniform float uImageOpacity;
      uniform bool uCover;
      uniform vec2 uFocus;
      uniform vec2 uImageSize;
      varying vec2 vUv;
      ${CLIP_GLSL}

      float cornerRadius(vec2 p, vec4 r) {
        // p: y up. Quadrants: top-left, top-right, bottom-right, bottom-left.
        return p.x < 0.0 ? (p.y > 0.0 ? r.x : r.w) : (p.y > 0.0 ? r.y : r.z);
      }
      float roundBox(vec2 p, vec2 halfSize, float r) {
        r = min(r, min(halfSize.x, halfSize.y));
        vec2 q = abs(p) - halfSize + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      void main() {
        applyClip();
        vec2 p = (vUv - 0.5) * uSize;
        float outer = roundBox(p, uSize * 0.5, cornerRadius(p, uRadius));
        // Inner edge: the box inset by the border widths, corners shrunk to match.
        vec2 innerCenter = vec2(uBorder.w - uBorder.y, uBorder.z - uBorder.x) * 0.5;
        vec2 innerHalf = max(uSize * 0.5 - vec2(uBorder.y + uBorder.w, uBorder.x + uBorder.z) * 0.5, 0.0);
        float innerR = max(cornerRadius(p, uRadius) - max(max(uBorder.x, uBorder.y), max(uBorder.z, uBorder.w)), 0.0);
        float inner = roundBox(p - innerCenter, innerHalf, innerR);
        float aa = max(fwidth(outer), 1e-4);
        float coverage = clamp(0.5 - outer / aa, 0.0, 1.0);
        float innerMix = clamp(0.5 - inner / max(fwidth(inner), 1e-4), 0.0, 1.0);

        vec4 fill = uBackground;
        if (uHasImage) {
          vec2 uv = vUv;
          if (uCover) {
            float box = uSize.x / max(uSize.y, 1e-4);
            float img = uImageSize.x / max(uImageSize.y, 1e-4);
            vec2 scale = img > box ? vec2(box / img, 1.0) : vec2(1.0, img / box);
            // The visible fraction of the image, slid toward the focal point.
            uv = (1.0 - scale) * uFocus + vUv * scale;
          }
          vec4 texel = texture2D(uImage, vec2(uv.x, 1.0 - uv.y));
          fill = vec4(texel.rgb, texel.a * uImageOpacity);
        }
        bool hasBorder = uBorderColor.a > 0.0 && (uBorder.x + uBorder.y + uBorder.z + uBorder.w) > 0.0;
        vec4 color = hasBorder ? mix(uBorderColor, fill, innerMix) : fill;
        gl_FragColor = vec4(color.rgb, color.a * coverage);
        if (gl_FragColor.a <= 0.0) discard;
      }`,
  });
  if (image) {
    // The cover fit needs the image's own aspect, known once its pixels have loaded.
    material.onBeforeRender = () => {
      const img = image.image as { width?: number; height?: number } | undefined;
      if (img?.width && img.height) material.uniforms.uImageSize!.value.set(img.width, img.height);
    };
  }
  return material;
}

function glyphGeometry(glyphs: Float32Array): THREE.BufferGeometry {
  const count = glyphs.length / 8;
  const position = new Float32Array(count * 12);
  const uv = new Float32Array(count * 8);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const [x0, y0, x1, y1, u0, v0, u1, v1] = glyphs.subarray(i * 8, i * 8 + 8);
    position.set([x0!, y0!, 0, x0!, y1!, 0, x1!, y1!, 0, x1!, y0!, 0], i * 12);
    uv.set([u0!, v0!, u0!, v1!, u1!, v1!, u1!, v0!], i * 8);
    const v = i * 4;
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

function msdfMaterial(d: TextRunData, atlas: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uAtlas: { value: atlas },
      uColor: { value: new THREE.Vector4(...d.color) },
      uPxRange: { value: d.pxRange },
      ...clipUniforms(d.clip),
    },
    vertexShader: /* glsl */ `
      uniform mat4 uItem;
      varying vec2 vUv;
      varying vec3 vNode;
      void main() {
        vUv = uv;
        vNode = (uItem * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec4 uColor;
      uniform float uPxRange;
      varying vec2 vUv;
      ${CLIP_GLSL}
      float median(float r, float g, float b) { return max(min(r, g), min(max(r, g), b)); }
      void main() {
        applyClip();
        vec3 msd = texture2D(uAtlas, vUv).rgb;
        vec2 unitRange = vec2(uPxRange) / vec2(textureSize(uAtlas, 0));
        vec2 screenTexSize = vec2(1.0) / fwidth(vUv);
        float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
        float alpha = clamp(screenPxRange * (median(msd.r, msd.g, msd.b) - 0.5) + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(uColor.rgb, uColor.a * alpha);
        if (gl_FragColor.a <= 0.0) discard;
      }`,
  });
}

// ---- connection ----

const replica = new SceneStore();
const view = new SceneView(replica);
const stats = { deltas: 0, bytes: 0, resyncs: 0, lastDeltaBytes: 0, connected: false, pointerEvents: 0 };
let socket: WebSocket | null = null;

function connect(): void {
  const url = new URL("scene", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  socket = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => stats.connected = true;
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.poses) view.setPoses(message.poses);
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    stats.deltas++;
    stats.bytes += bytes.byteLength;
    stats.lastDeltaBytes = bytes.byteLength;
    try {
      const delta = decodeDelta(bytes);
      replica.apply(delta);
      ws.send(JSON.stringify({ ack: delta.toTick }));
    } catch (error) {
      if (!(error instanceof StoreDivergence)) console.error("scene-stream:", error);
      stats.resyncs++;
      ws.send(JSON.stringify({ resync: true }));
    }
  };
  ws.onclose = () => {
    stats.connected = false;
    if (socket === ws) socket = null;
    setTimeout(connect, 1000);
  };
}

// ---- rendering ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const canvas = renderer.domElement;

const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 200);
camera.matrixAutoUpdate = false;
const controller = new ViewCameraController(camera);

function resize(): void {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

/**
 * Frames the scene's world-placed content: centred on its bounds, backed off along the facing
 * direction of the largest UI quad (the panel most likely to be read).
 */
function frameContent(): boolean {
  const bounds = new THREE.Box3();
  let facing: THREE.Vector3 | null = null;
  let largest = 0;
  view.scene.updateMatrixWorld(true);
  view.scene.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh || object.parent?.parent !== view.scene) return; // world node only
    bounds.expandByPoint(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld));
    const material = (object as THREE.Mesh).material as THREE.ShaderMaterial;
    if (!material.uniforms?.uSize) return;
    const scale = new THREE.Vector3().setFromMatrixScale(object.matrixWorld);
    if (scale.x * scale.y > largest) {
      largest = scale.x * scale.y;
      facing = new THREE.Vector3().setFromMatrixColumn(object.matrixWorld, 2).normalize();
    }
  });
  if (bounds.isEmpty()) return false;
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.3);
  controller.frame(bounds.getCenter(new THREE.Vector3()), facing ?? new THREE.Vector3(0, 0, 1), radius * 1.8);
  return true;
}

// Open framed on the content: the headset may be facing anywhere. F switches to its view.
const opening = setInterval(() => {
  if (replica.size("items") > 0 && frameContent()) clearInterval(opening);
}, 200);

addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "g" || event.key === "G") {
    frameContent();
  } else if (event.key === "f" || event.key === "F") {
    const head = view.pose("viewer");
    if (controller.mode === "head" && head) controller.freeFrom(head);
    else controller.mode = "head";
  }
});

// ---- input: navigation here, interaction to the scene ----

let sequence = 0;
/** Drags that navigate, by DOM pointer id; those events never reach the scene. */
const navigating = new Map<number, ReturnType<typeof dragAction>>();

function sendPointer(
  type: "pointermove" | "pointerdown" | "pointerup" | "pointercancel" | "pointerleave" | "wheel",
  event: PointerEvent | WheelEvent,
  deltaY?: number,
): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const rect = canvas.getBoundingClientRect();
  stats.pointerEvents++;
  socket.send(JSON.stringify({
    pointer: {
      version: 1,
      viewport: "scene-view",
      sequence: sequence++,
      type,
      pointerId: "pointerId" in event ? event.pointerId : 1,
      pointerType: "pointerType" in event && event.pointerType ? event.pointerType : "mouse",
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      button: type === "pointermove" || type === "wheel" ? -1 : event.button,
      buttons: event.buttons & 1, // only the interaction button is the scene's
      ...(deltaY !== undefined ? { deltaY } : {}),
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      camera: { matrixWorld: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() },
    },
  }));
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerdown", (event) => {
  const action = dragAction(event.button, event.shiftKey);
  canvas.setPointerCapture(event.pointerId);
  if (action === "scene") sendPointer("pointerdown", event);
  else navigating.set(event.pointerId, action);
});
canvas.addEventListener("pointermove", (event) => {
  const action = navigating.get(event.pointerId);
  if (action === "orbit") controller.orbit(event.movementX, event.movementY);
  else if (action === "pan") {
    controller.pan(event.movementX, event.movementY, canvas.clientHeight, THREE.MathUtils.degToRad(camera.fov));
  } else sendPointer("pointermove", event);
});
const endPointer = (type: "pointerup" | "pointercancel") => (event: PointerEvent) => {
  if (navigating.delete(event.pointerId)) return;
  sendPointer(type, event);
};
canvas.addEventListener("pointerup", endPointer("pointerup"));
canvas.addEventListener("pointercancel", endPointer("pointercancel"));
canvas.addEventListener("pointerleave", (event) => {
  if (!navigating.has(event.pointerId)) sendPointer("pointerleave", event);
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  if (wheelNavigates(event.ctrlKey, event.metaKey)) controller.dolly(Math.exp(pixels * 0.002));
  else sendPointer("wheel", event, pixels);
}, { passive: false });
// Leaving the page must not leave a press held in the scene.
addEventListener("blur", () => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  sendPointer("pointercancel", new PointerEvent("pointercancel", { pointerId: 1 }));
});

const hud = document.getElementById("hud")!;
let hudAt = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  controller.apply(view.pose("viewer"));
  view.update(camera);
  renderer.render(view.scene, camera);
  if (now - hudAt > 250) {
    hudAt = now;
    hud.textContent = `${stats.connected ? "connected" : "connecting…"} · tick ${replica.sourceTick} · ` +
      `${replica.size("items")} items · ${stats.deltas} deltas, ${(stats.bytes / 1024).toFixed(0)} KiB ` +
      `(last ${stats.lastDeltaBytes} B) · ${controller.mode === "head" ? "head view" : "free view"} · ` +
      `left: interact · right: orbit · middle: pan · ctrl+wheel: zoom · F head · G frame`;
  }
}

/** For inspection from the console or a test harness. */
(globalThis as { sceneStream?: unknown }).sceneStream = { replica, view, camera, controller, renderer, stats, THREE };

connect();
requestAnimationFrame(frame);
