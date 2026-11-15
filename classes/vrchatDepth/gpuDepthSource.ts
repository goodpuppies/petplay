/**
 * Depth frames from VRChat's window without ffmpeg (`gpuWindowCapture.ts`): per window redraw, the
 * CPU reads back only the block's rectangle (header + a nearest-sampled small grid, as
 * `WindowDepthDecoder` produced) and a nearest-blitted colour grid, while the full-resolution plane
 * stays in the window texture for the foreground shader (`DepthForeground.block`).
 *
 * Runs on the render thread with raylib's GL context current.
 */
import {
  type BlockLocation,
  decodeImage,
  DEFAULT_DEPTH_FAR,
  FLAG_DEPTH_CAMERA,
  FLAG_VRCHAT_CAMERA,
  QUIET_CELLS,
} from "./format.ts";
import { GpuWindowCapture } from "./gpuWindowCapture.ts";
import type { ColorClassifier } from "./colorCalibration.ts";
import type { Table3d } from "./foreground.ts";
import type { RawDepthFrame } from "./windowDecoder.ts";
import { findX11Window } from "../x11Windows.ts";

/** Margin of the rectangle read around the block, in pixels, so a slightly moved block is found. */
const RECT_MARGIN = 4;
/** A full-window readback (to find a lost block) costs ~4 ms; at most this often. */
const RELOCATE_EVERY_MS = 500;
const REOPEN_EVERY_MS = 2000;

export class GpuDepthSource {
  capture: GpuWindowCapture | null = null;
  location: BlockLocation | null = null;
  private blockSize: [number, number] | null = null;
  private rect = new Uint8Array(0);
  private lastRelocateAt = 0;
  private lastOpenAt = 0;
  lastTimeTag = -1;
  repeats = 0;
  decoded = 0;
  failures: Record<string, number> = {};
  lastFailure: string | null = null;
  decodeMs = 0;
  openError: string | null = null;
  /**
   * Read the window's colours at the depth samples (a second blit and synchronous readback, about
   * as long as the block's own). Off while no consumer uses them (`VRCDEPTHWANTS`).
   */
  colors = true;
  /**
   * 3D calibration: building the shader table takes ~130 ms, so it is requested from elsewhere
   * (the capture worker) and the foreground pass waits for it.
   */
  requestTable: ((request: { id: number; samples: Uint8Array; levels: number }) => void) | null =
    null;
  private table3d: Table3d | null = null;
  private tableClassifier: ColorClassifier | null = null;
  private pendingTable: { id: number; classifier: ColorClassifier } | null = null;
  private tableIds = 0;

  constructor(public grid = 128, public windowName = "VRChat") {}

  /** A new frame since the last call, or null. Cheap when VRChat has not redrawn. */
  poll(): RawDepthFrame | null {
    if (!this.ensureOpen()) return null;
    const capture = this.capture!;
    if (!capture.poll()) {
      if (capture.lost) this.close(capture.lost);
      return null;
    }
    const started = performance.now();
    const frame = this.decode(capture);
    const decodeMs = performance.now() - started;
    this.decodeMs = this.decodeMs * 0.9 + decodeMs * 0.1;
    if (frame) frame.decodeMs = decodeMs;
    return frame;
  }

  status() {
    return {
      source: "gpu" as const,
      capture: this.capture?.status() ?? null,
      location: this.location,
      decoded: this.decoded,
      repeats: this.repeats,
      failures: this.failures,
      lastFailure: this.lastFailure,
      decodeMs: this.decodeMs,
      openError: this.openError,
    };
  }

  dispose(): void {
    this.close(null);
  }

  /** A table built for `requestTable`'s request `id`. */
  receiveTable(id: number, table: Omit<Table3d, "revision">): void {
    if (this.pendingTable?.id !== id) return;
    this.table3d = { ...table, revision: id };
    this.tableClassifier = this.pendingTable.classifier;
    this.pendingTable = null;
  }

  /** The table for `classifier`, requesting one when it changed; null until it arrives. */
  private tableFor(classifier: ColorClassifier): Table3d | null {
    if (this.tableClassifier === classifier) return this.table3d;
    if (this.pendingTable?.classifier !== classifier && this.requestTable) {
      this.pendingTable = { id: ++this.tableIds, classifier };
      this.requestTable({
        id: this.pendingTable.id,
        samples: classifier.samples.slice(),
        levels: classifier.levels,
      });
    }
    return null;
  }

  private ensureOpen(): boolean {
    if (this.capture) return true;
    const now = performance.now();
    if (now - this.lastOpenAt < REOPEN_EVERY_MS) return false;
    this.lastOpenAt = now;
    try {
      const window = findX11Window(this.windowName);
      if (!window) throw new Error(`no "${this.windowName}" window`);
      this.capture = GpuWindowCapture.open(window.id);
      this.location = null;
      this.openError = null;
      return true;
    } catch (error) {
      this.openError = String(error);
      return false;
    }
  }

  private close(reason: string | null): void {
    this.capture?.dispose();
    this.capture = null;
    this.location = null;
    if (reason) this.openError = reason;
  }

  private fail(reason: string, detail?: string): null {
    this.lastFailure = detail ? `${reason}: ${detail}` : reason;
    this.failures[reason] = (this.failures[reason] ?? 0) + 1;
    return null;
  }

  private decode(capture: GpuWindowCapture): RawDepthFrame | null {
    const receivedAt = capture.lastBindAt;
    const { width, height } = capture;
    let result: ReturnType<typeof decodeImage> | null = null;
    let offset = [0, 0];
    if (this.location && this.blockSize) {
      const x = Math.max(0, Math.floor(this.location.x0) - RECT_MARGIN);
      const y = Math.max(0, Math.floor(this.location.y0) - RECT_MARGIN);
      const w = Math.min(width - x, Math.ceil(this.blockSize[0]) + 2 * RECT_MARGIN);
      const h = Math.min(height - y, Math.ceil(this.blockSize[1]) + 2 * RECT_MARGIN);
      if (w > 0 && h > 0) {
        if (this.rect.length < w * h * 4) this.rect = new Uint8Array(w * h * 4);
        capture.readRect(x, y, w, h, this.rect);
        const hint = {
          x0: this.location.x0 - x,
          y0: this.location.y0 - y,
          pitch: this.location.pitch,
        };
        result = decodeImage({ width: w, height: h, data: this.rect, channels: 4 }, hint, {
          depthGrid: this.grid,
        });
        offset = [x, y];
      }
    }
    if (!result?.ok) {
      const now = performance.now();
      if (now - this.lastRelocateAt < RELOCATE_EVERY_MS) {
        return this.fail(
          result ? result.reason : "not-found",
          result?.ok === false ? result.detail : undefined,
        );
      }
      this.lastRelocateAt = now;
      if (this.rect.length < width * height * 4) this.rect = new Uint8Array(width * height * 4);
      capture.readRect(0, 0, width, height, this.rect);
      result = decodeImage({ width, height, data: this.rect, channels: 4 }, undefined, {
        depthGrid: this.grid,
      });
      offset = [0, 0];
    }
    if (!result.ok) {
      this.location = null;
      return this.fail(result.reason, result.detail);
    }
    const location = {
      x0: result.location.x0 + offset[0],
      y0: result.location.y0 + offset[1],
      pitch: result.location.pitch,
    };
    const { header, layout } = result.frame;
    this.location = location;
    this.blockSize = [layout.gridWidth * location.pitch, layout.gridHeight * location.pitch];
    this.lastFailure = null;
    if (header.timeTag === this.lastTimeTag) {
      this.repeats++;
      return null;
    }
    this.lastTimeTag = header.timeTag;
    this.decoded++;
    const sameSize = header.flags & FLAG_VRCHAT_CAMERA && !(header.flags & FLAG_DEPTH_CAMERA) &&
      width === Math.round(header.screenWidth) &&
      height === Math.round(header.screenHeight);
    let colors: Uint8Array | null = null;
    if (sameSize && this.colors) {
      colors = new Uint8Array(result.frame.width * result.frame.height * 4);
      capture.readScaled(result.frame.width, result.frame.height, colors);
      maskBlock(colors, result.frame.width, result.frame.height, width, height, location, layout);
    }
    return {
      receivedAt,
      decodeMs: 0,
      header,
      width: result.frame.width,
      height: result.frame.height,
      depth: result.frame.depth,
      colors,
      foregroundBlock: result.classifier && !this.tableFor(result.classifier) ? undefined : {
        textureId: capture.textureId,
        textureWidth: width,
        textureHeight: height,
        x0: location.x0,
        y0: location.y0,
        pitch: location.pitch,
        gridWidth: layout.gridWidth,
        dataStartRow: layout.dataStartRow,
        depthStartCell: layout.depthStartCell,
        bits: layout.bits,
        depthWidth: layout.depthWidth,
        depthHeight: layout.depthHeight,
        depthRef: header.depthRef,
        depthFar: header.depthFar ?? DEFAULT_DEPTH_FAR,
        luts: result.luts,
        table3d: result.classifier ? this.tableFor(result.classifier)! : undefined,
      },
    };
  }
}

/** As `sampleColors`: alpha 255 for image samples, 0 where the block and its quiet zone cover it. */
function maskBlock(
  colors: Uint8Array,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
  location: BlockLocation,
  layout: { gridWidth: number; gridHeight: number },
): void {
  const pad = QUIET_CELLS * location.pitch;
  const x0 = location.x0 - pad, y0 = location.y0 - pad;
  const x1 = location.x0 + layout.gridWidth * location.pitch + pad;
  const y1 = location.y0 + layout.gridHeight * location.pitch + pad;
  for (let j = 0; j < height; j++) {
    const y = Math.min(imageHeight - 1, Math.floor((j + 0.5) * imageHeight / height));
    for (let i = 0; i < width; i++) {
      const x = Math.min(imageWidth - 1, Math.floor((i + 0.5) * imageWidth / width));
      const o = (j * width + i) * 4;
      colors[o + 3] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 0 : 255;
    }
  }
}
