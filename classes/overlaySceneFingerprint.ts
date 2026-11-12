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
  const h = new Hasher();
  h.number(extra);
  const f = payload.frame;
  for (const v of [f.eyeWidth, f.eyeHeight, f.outputWidth, f.outputHeight]) h.number(v);
  h.number(f.halfFovInRadians);
  h.value(f.leftEyeProjectionMatrix);
  h.value(f.rightEyeProjectionMatrix);
  h.value(payload.background);
  h.value(payload.renderGripOffsets);
  for (const eye of [payload.leftEye, payload.rightEye]) {
    h.value(eye.assets);
    h.value(eye.frame.lights);
    h.items(eye.frame.instances);
  }
  h.items(payload.ui.panels);
  h.items(payload.ui.texts);
  h.items(payload.ui.images);
  h.value(payload.ui.textRendering);
  return h.digest();
}

const ANCHOR_DERIVED = new Set(["worldMatrix", "normalMatrix", "clipping"]);

class Hasher {
  // FNV-1a over 32-bit words; numbers enter as their float64 bit patterns.
  private state = 0x811c9dc5;
  private readonly f64 = new Float64Array(1);
  private readonly u32 = new Uint32Array(this.f64.buffer);

  digest(): number {
    return this.state >>> 0;
  }

  private word(w: number): void {
    this.state = Math.imul(this.state ^ w, 0x01000193);
  }

  number(n: number): void {
    this.f64[0] = n;
    this.word(this.u32[0]!);
    this.word(this.u32[1]!);
  }

  private string(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  /** Arrays of scene items: anchored items skip their anchor-derived fields. */
  items(list: readonly object[] | undefined): void {
    if (!list) return this.word(0);
    this.word(list.length);
    for (const item of list) {
      const anchored = !!(item as { renderAnchor?: unknown }).renderAnchor;
      this.object(item as Record<string, unknown>, anchored ? ANCHOR_DERIVED : null);
    }
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
      const a = v as unknown as ArrayLike<number | bigint>;
      this.word(a.length);
      for (let i = 0; i < a.length; i++) this.number(Number(a[i]));
      return;
    }
    if (Array.isArray(v)) {
      this.word(v.length);
      for (const x of v) this.value(x);
      return;
    }
    this.object(v as Record<string, unknown>, null);
  }

  private object(o: Record<string, unknown>, skip: Set<string> | null): void {
    if (typeof o.id === "number" && typeof o.revision === "number") {
      this.word(6);
      this.number(o.id);
      this.number(o.revision);
      return;
    }
    for (const key in o) {
      if (skip?.has(key)) continue;
      this.string(key);
      this.value(o[key]);
    }
  }
}
