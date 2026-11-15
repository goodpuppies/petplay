/**
 * VRChat's depth block for the headset, decoded where it is drawn
 * (`markdown/vrchat-depth/cpu-gpu-audit.md`): runs on the webxr render thread with raylib's GLX
 * context current and binds VRChat's window as a texture (`gpuWindowCapture.ts`). The occluder
 * decodes depth from that texture on the GPU (`OCCLUDER_VERTEX`); the CPU only reads the block's
 * rectangle back **asynchronously** for the header (camera pose, projection, lighting, time tag),
 * one frame or so later, and never waits on the GPU.
 *
 * Two texture slots keep header and depth from the same VRChat frame: a redraw is bound into the
 * slot not being shown, its rectangle is read back, and only once its header has decoded does that
 * slot become the shown one. Redraws while a read is outstanding wait (the latest is taken next).
 */
import {
  type BlockLocation,
  decodeImage,
  DEFAULT_DEPTH_FAR,
  type DepthFrameHeader,
  type DerivedLayout,
} from "./format.ts";
import { GpuWindowCapture } from "./gpuWindowCapture.ts";
import type { ColorClassifier } from "./colorCalibration.ts";
import type { DepthForegroundBlock, Table3d } from "./foreground.ts";
import type { TableReply, TableRequest } from "./tableWorker.ts";
import { findX11Window } from "../x11Windows.ts";

/** Margin of the rectangle read around the block, in pixels, so a slightly moved block is found. */
const RECT_MARGIN = 4;
/** A whole-window readback (to find a lost block) at most this often. */
const RELOCATE_EVERY_MS = 500;
const REOPEN_EVERY_MS = 2000;
/** A read whose fence hasn't passed by now is dropped (the GPU reset or the context changed). */
const READ_TIMEOUT_MS = 500;

export type HeadsetDepthFrame = {
  /** `Date.now()` when VRChat's redraw was bound: the frame's arrival. */
  receivedAt: number;
  /** CPU time of the header decode. */
  decodeMs: number;
  header: DepthFrameHeader;
  layout: DerivedLayout;
  /** For the occluder; null in 3D calibration until its table has been built. */
  block: DepthForegroundBlock | null;
  /** The nearest-sampled grid, metres, only when `cpuGrid` asked for it (debug mesh, scan). */
  depth: Float32Array | null;
  width: number;
  height: number;
};

export class HeadsetDepthSource {
  capture: GpuWindowCapture | null = null;
  location: BlockLocation | null = null;
  /** Decode this many samples a side on the CPU as well (debug mesh, scan); 0 = header only. */
  cpuGrid = 0;
  decoded = 0;
  repeats = 0;
  failures: Record<string, number> = {};
  lastFailure: string | null = null;
  decodeMs = 0;
  openError: string | null = null;
  lastFrameAt = 0;
  private blockSize: [number, number] | null = null;
  private shownSlot = -1;
  private read: {
    slot: number;
    x: number;
    y: number;
    w: number;
    h: number;
    at: number;
    boundAt: number;
  } | null = null;
  private rect = new Uint8Array(0);
  private lastRelocateAt = 0;
  private lastOpenAt = 0;
  private lastTimeTag = -1;
  private tables: Worker | null = null;
  private table3d: Table3d | null = null;
  private tableClassifier: ColorClassifier | null = null;
  private pendingTable: { id: number; classifier: ColorClassifier } | null = null;
  private tableIds = 0;

  constructor(public windowName = "VRChat") {}

  /**
   * Once per headset frame, before drawing: collects a finished read (a new frame, or null), and
   * starts the next one when VRChat has redrawn. Cheap when nothing happened.
   */
  tick(): HeadsetDepthFrame | null {
    if (!this.ensureOpen()) return null;
    const capture = this.capture!;
    let frame: HeadsetDepthFrame | null = null;
    if (this.read) {
      if (capture.finishReadRect(this.rect)) {
        frame = this.decode(this.read);
        this.read = null;
      } else if (performance.now() - this.read.at > READ_TIMEOUT_MS) {
        this.read = null;
        this.fail("read-timeout");
      }
    }
    if (!this.read && capture.damaged()) this.startRead(capture);
    if (capture.lost) this.close(capture.lost);
    return frame;
  }

  status() {
    return {
      source: "headset" as const,
      capture: this.capture?.status() ?? null,
      location: this.location,
      decoded: this.decoded,
      repeats: this.repeats,
      failures: this.failures,
      lastFailure: this.lastFailure,
      decodeMs: this.decodeMs,
      openError: this.openError,
      shownSlot: this.shownSlot,
      table3d: this.table3d ? this.table3d.revision : null,
    };
  }

  dispose(): void {
    this.close(null);
    this.tables?.terminate();
    this.tables = null;
  }

  private startRead(capture: GpuWindowCapture): void {
    // Never the shown slot: the occluder is drawing from it.
    const slot = this.shownSlot === 0 ? 1 : 0;
    if (!capture.bindDamage(slot)) return;
    const boundAt = capture.lastBindAt;
    const { width, height } = capture;
    let x = 0, y = 0, w = width, h = height;
    if (this.location && this.blockSize) {
      x = Math.max(0, Math.floor(this.location.x0) - RECT_MARGIN);
      y = Math.max(0, Math.floor(this.location.y0) - RECT_MARGIN);
      w = Math.min(width - x, Math.ceil(this.blockSize[0]) + 2 * RECT_MARGIN);
      h = Math.min(height - y, Math.ceil(this.blockSize[1]) + 2 * RECT_MARGIN);
    } else {
      const now = performance.now();
      if (now - this.lastRelocateAt < RELOCATE_EVERY_MS) return;
      this.lastRelocateAt = now;
    }
    if (w <= 0 || h <= 0) return;
    if (this.rect.length < w * h * 4) this.rect = new Uint8Array(w * h * 4);
    if (capture.startReadRect(slot, x, y, w, h)) {
      this.read = { slot, x, y, w, h, at: performance.now(), boundAt };
    }
  }

  private decode(read: NonNullable<HeadsetDepthSource["read"]>): HeadsetDepthFrame | null {
    const capture = this.capture!;
    const started = performance.now();
    const whole = read.w === capture.width && read.h === capture.height && read.x === 0 &&
      read.y === 0;
    const hint = this.location && !whole
      ? { x0: this.location.x0 - read.x, y0: this.location.y0 - read.y, pitch: this.location.pitch }
      : undefined;
    const result = decodeImage(
      { width: read.w, height: read.h, data: this.rect, channels: 4 },
      hint,
      {
        depthGrid: this.cpuGrid > 0 ? this.cpuGrid : 1,
      },
    );
    this.decodeMs = this.decodeMs * 0.9 + (performance.now() - started) * 0.1;
    if (!result.ok) {
      // A rectangle that lost the block: find it again with a whole-window read.
      if (!whole) this.location = null;
      return this.fail(result.reason);
    }
    const location = {
      x0: result.location.x0 + read.x,
      y0: result.location.y0 + read.y,
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
    this.lastFrameAt = Date.now();
    this.shownSlot = read.slot;
    const table = result.classifier ? this.tableFor(result.classifier) : null;
    return {
      receivedAt: read.boundAt,
      decodeMs: this.decodeMs,
      header,
      layout,
      block: result.classifier && !table ? null : {
        textureId: capture.textures[read.slot],
        textureWidth: capture.width,
        textureHeight: capture.height,
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
        table3d: table ?? undefined,
      },
      depth: this.cpuGrid > 0 ? result.frame.depth : null,
      width: result.frame.width,
      height: result.frame.height,
    };
  }

  private fail(reason: string): null {
    this.failures[reason] = (this.failures[reason] ?? 0) + 1;
    this.lastFailure = reason;
    return null;
  }

  /** The table for `classifier`, built off-thread when it changed; null until it arrives. */
  private tableFor(classifier: ColorClassifier): Table3d | null {
    if (this.tableClassifier === classifier) return this.table3d;
    if (this.pendingTable?.classifier !== classifier) {
      this.pendingTable = { id: ++this.tableIds, classifier };
      this.tables ??= this.startTableWorker();
      const request: TableRequest = {
        id: this.pendingTable.id,
        samples: classifier.samples.slice(),
        levels: classifier.levels,
      };
      this.tables.postMessage(request, [request.samples.buffer]);
    }
    // Until the new one arrives, a table for an earlier classifier of the same world still decodes.
    return this.table3d;
  }

  private startTableWorker(): Worker {
    const worker = new Worker(new URL("./tableWorker.ts", import.meta.url).href, {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<TableReply>) => {
      const { id, ...table } = event.data;
      if (this.pendingTable?.id !== id) return;
      this.table3d = { ...table, revision: id };
      this.tableClassifier = this.pendingTable.classifier;
      this.pendingTable = null;
    };
    return worker;
  }

  private ensureOpen(): boolean {
    if (this.capture) return true;
    const now = performance.now();
    if (now - this.lastOpenAt < REOPEN_EVERY_MS) return false;
    this.lastOpenAt = now;
    try {
      const window = findX11Window(this.windowName);
      if (!window) throw new Error(`no "${this.windowName}" window`);
      this.capture = GpuWindowCapture.open(window.id, 2);
      this.location = null;
      this.shownSlot = -1;
      this.read = null;
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
    this.shownSlot = -1;
    this.read = null;
    if (reason) this.openError = reason;
  }
}
