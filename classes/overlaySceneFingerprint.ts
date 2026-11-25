import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

/**
 * Hash of the scene content a decoupled renderer cannot derive itself. Two payloads with the
 * same fingerprint render identically there, so the producer can skip sending the second one.
 *
 * Left out, because the renderer replaces them every frame:
 * - head/camera state (`frame` views and poses, extraction cameras): it samples its own tracking;
 * - world matrices and clip planes of items with a `renderAnchor`: it rebuilds them from the
 *   anchor's local matrix and a fresh tracked pose;
 * - delivery identity, frame counters and extraction warnings.
 *
 * Objects carrying numeric `id` and `revision` (assets, glyph geometry) hash by those alone.
 * Collisions only cost a skipped update until the next change or keepalive; this is not a
 * security boundary.
 */
export function fingerprintScene(payload: WebXRRaythreeRenderPayload, extra = 0): number {
  const h = HASHER;
  h.reset();
  h.number(extra);
  const f = payload.frame;
  h.number(f.eyeWidth);
  h.number(f.eyeHeight);
  h.number(f.outputWidth);
  h.number(f.outputHeight);
  h.number(f.halfFovInRadians);
  h.value(f.leftEyeProjectionMatrix);
  h.value(f.rightEyeProjectionMatrix);
  h.value(payload.background);
  h.value(payload.renderGripOffsets);
  h.eye(payload.leftEye);
  if (payload.rightEye !== payload.leftEye) {
    h.eye(payload.rightEye);
  }
  h.panels(payload.ui.panels);
  h.texts(payload.ui.texts);
  h.items(payload.ui.images);
  h.value(payload.ui.textRendering);
  return h.digest();
}

const KEY_HASH_CACHE = new Map<string, number>();

function keyHash(key: string): number {
  const cached = KEY_HASH_CACHE.get(key);
  if (cached !== undefined) return cached;
  let s = 0x811c9dc5 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    s = Math.imul(s ^ key.charCodeAt(i), 0x01000193);
  }
  const result = s >>> 0;
  if (KEY_HASH_CACHE.size < 4096) KEY_HASH_CACHE.set(key, result);
  return result;
}

class Hasher {
  // FNV-1a over 32-bit words; numbers enter as their float64 bit patterns.
  private state = 0x811c9dc5;
  private readonly f64 = new Float64Array(1);
  private readonly u32 = new Uint32Array(this.f64.buffer);
  private readonly f32Scratch = new Float32Array(16);
  private readonly f32ScratchU32 = new Uint32Array(this.f32Scratch.buffer);
  private readonly f64Scratch = new Float64Array(16);
  private readonly f64ScratchU32 = new Uint32Array(this.f64Scratch.buffer);

  reset(): void {
    this.state = 0x811c9dc5;
  }

  digest(): number {
    return this.state >>> 0;
  }

  private word(w: number): void {
    this.state = Math.imul(this.state ^ w, 0x01000193);
  }

  number(n: number): void {
    this.f64[0] = n;
    let s = this.state;
    s = Math.imul(s ^ this.u32[0]!, 0x01000193);
    s = Math.imul(s ^ this.u32[1]!, 0x01000193);
    this.state = s;
  }

  private string(str: string): void {
    let s = Math.imul(this.state ^ str.length, 0x01000193);
    for (let i = 0; i < str.length; i++) {
      s = Math.imul(s ^ str.charCodeAt(i), 0x01000193);
    }
    this.state = s;
  }

  eye(eye: WebXRRaythreeRenderPayload["leftEye"]): void {
    this.value(eye.assets);
    this.value(eye.frame.lights);
    this.items(eye.frame.instances);
  }

  private f32(v: Float32Array | undefined): void {
    if (v === undefined) {
      this.word(1);
      return;
    }
    const len = v.length;
    let s = Math.imul(this.state ^ (len << 2), 0x01000193);
    if (len <= 16) {
      this.f32Scratch.set(v);
      const u = this.f32ScratchU32;
      for (let i = 0; i < len; i++) {
        s = Math.imul(s ^ u[i]!, 0x01000193);
      }
      this.state = s;
      return;
    }
    this.state = s;
    this.typedArray(v);
  }

  private anchor(
    a: { space: string; localMatrix: ArrayBufferView; follow?: true; pair?: unknown },
  ): void {
    this.string(a.space);
    this.typedArray(a.localMatrix);
    if (a.follow) this.word(7);
    if (a.pair !== undefined) this.value(a.pair);
  }

  panels(list: WebXRRaythreeRenderPayload["ui"]["panels"] | undefined): void {
    if (!list) {
      this.word(0);
      return;
    }
    const len = list.length;
    this.word(len);
    for (let i = 0; i < len; i++) {
      const p = list[i]!;
      const ra = p.renderAnchor;
      if (ra != null) {
        this.word(11);
        this.anchor(ra);
      } else {
        this.word(12);
        this.f32(p.worldMatrix);
        this.f32(p.clipping);
      }
      this.f32(p.data);
      let s = this.state;
      s = Math.imul(s ^ (p.instanceIndex | 0), 0x01000193);
      s = Math.imul(s ^ (p.renderOrder | 0), 0x01000193);
      s = Math.imul(s ^ (p.rootIndex | 0), 0x01000193);
      s = Math.imul(s ^ ((p.depthTest ? 1 : 0) | (p.depthWrite ? 2 : 0)), 0x01000193);
      const oi = p.orderInfo;
      if (oi !== undefined) {
        s = Math.imul(s ^ (oi.majorIndex | 0), 0x01000193);
        s = Math.imul(s ^ (oi.minorIndex | 0), 0x01000193);
        s = Math.imul(s ^ (oi.elementType | 0), 0x01000193);
        s = Math.imul(s ^ (oi.patchIndex | 0), 0x01000193);
      }
      this.state = s;
    }
  }

  texts(list: WebXRRaythreeRenderPayload["ui"]["texts"] | undefined): void {
    if (!list) {
      this.word(0);
      return;
    }
    const len = list.length;
    this.word(len);
    for (let i = 0; i < len; i++) {
      const t = list[i]!;
      const ra = t.renderAnchor;
      if (ra != null) {
        this.word(13);
        this.anchor(ra);
      } else {
        this.word(14);
        this.f32(t.worldMatrix);
      }
      this.string(t.text);
      if (t.color !== undefined) {
        this.number(t.color[0]);
        this.number(t.color[1]);
        this.number(t.color[2]);
        this.number(t.color[3]);
      }
      if (t.fontSize !== undefined) this.number(t.fontSize);
      if (t.align !== undefined) this.word(keyHash(t.align));
      if (t.anchorX !== undefined) this.word(keyHash(t.anchorX));
      if (t.font !== undefined) this.word(keyHash(t.font));
      this.word(t.rootIndex | 0);
      const b = t.bounds;
      if (b !== undefined) {
        this.number(b.minX);
        this.number(b.maxX);
        this.number(b.minY);
        this.number(b.maxY);
      }
      const g = t.geometry;
      if (g !== undefined) {
        if (typeof g.id === "number" && typeof g.revision === "number") {
          let s = Math.imul(this.state ^ 6, 0x01000193);
          s = Math.imul(s ^ (g.id | 0), 0x01000193);
          s = Math.imul(s ^ (g.revision | 0), 0x01000193);
          this.state = s;
        } else {
          this.value(g);
        }
      }
    }
  }

  /** Arrays of scene items: anchored items skip their anchor-derived fields. */
  items(list: readonly object[] | undefined): void {
    if (!list) {
      this.word(0);
      return;
    }
    const len = list.length;
    this.word(len);
    for (let i = 0; i < len; i++) {
      const item = list[i] as Record<string, unknown>;
      this.object(item, item.renderAnchor != null);
    }
  }

  private typedArray(v: ArrayBufferView): void {
    const byteLength = v.byteLength;
    let s = Math.imul(this.state ^ byteLength, 0x01000193);
    if (v instanceof Float32Array && v.length <= 16) {
      const len = v.length;
      this.f32Scratch.set(v);
      const u = this.f32ScratchU32;
      for (let i = 0; i < len; i++) {
        s = Math.imul(s ^ u[i]!, 0x01000193);
      }
      this.state = s;
      return;
    }
    if (v instanceof Float64Array && v.length <= 16) {
      const words = v.length << 1;
      this.f64Scratch.set(v);
      const u = this.f64ScratchU32;
      for (let i = 0; i < words; i++) {
        s = Math.imul(s ^ u[i]!, 0x01000193);
      }
      this.state = s;
      return;
    }
    const wordCount = byteLength >>> 2;
    if (wordCount > 0 && (v.byteOffset & 3) === 0) {
      const words = new Uint32Array(v.buffer, v.byteOffset, wordCount);
      for (let i = 0; i < wordCount; i++) {
        s = Math.imul(s ^ words[i]!, 0x01000193);
      }
      const rem = byteLength & 3;
      if (rem !== 0) {
        const bytes = new Uint8Array(v.buffer, v.byteOffset + (wordCount << 2), rem);
        for (let i = 0; i < rem; i++) {
          s = Math.imul(s ^ bytes[i]!, 0x01000193);
        }
      }
      this.state = s;
      return;
    }
    const bytes = new Uint8Array(v.buffer, v.byteOffset, byteLength);
    for (let i = 0; i < byteLength; i++) {
      s = Math.imul(s ^ bytes[i]!, 0x01000193);
    }
    this.state = s;
  }

  value(v: unknown): void {
    if (v === undefined) return this.word(1);
    if (v === null) return this.word(2);
    switch (typeof v) {
      case "number":
        return this.number(v);
      case "boolean":
        return this.word(v ? 3 : 4);
      case "string":
        return this.string(v);
      case "bigint":
        return this.string(v.toString());
      case "object":
        break;
      default:
        return this.word(5);
    }
    if (ArrayBuffer.isView(v)) {
      this.typedArray(v);
      return;
    }
    if (Array.isArray(v)) {
      const len = v.length;
      this.word(len);
      for (let i = 0; i < len; i++) this.value(v[i]);
      return;
    }
    this.object(v as Record<string, unknown>, false);
  }

  private object(o: Record<string, unknown>, skipAnchorDerived: boolean): void {
    if (typeof o.id === "number" && typeof o.revision === "number") {
      this.word(6);
      this.number(o.id);
      this.number(o.revision);
      return;
    }
    for (const key in o) {
      if (
        skipAnchorDerived &&
        (key === "worldMatrix" || key === "normalMatrix" || key === "clipping")
      ) {
        continue;
      }
      this.word(keyHash(key));
      this.value(o[key]);
    }
  }
}

const HASHER = new Hasher();
