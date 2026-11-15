import {
  type BlockLocation,
  decodeImage,
  type DepthFrameHeader,
  FLAG_DEPTH_CAMERA,
  FLAG_VRCHAT_CAMERA,
  QUIET_CELLS,
} from "./format.ts";
import { downsampleDepth } from "./sync.ts";
import type { WindowFrame } from "./windowStream.ts";
import { encodeBytesBase64, encodeDepthLog16, type VrcDepthFramePayload } from "./wire.ts";

export type DepthPlane = { width: number; height: number; depth: Float32Array };
export type RawDepthFrame = {
  /** Independent foreground plane; never expands the debug/VR mesh or its wire payload. */
  foreground?: DepthPlane;
  /** GPU capture: the full plane is still in VRChat's window texture (`gpuDepthSource.ts`). */
  foregroundBlock?: import("./foreground.ts").DepthForegroundBlock;
  decodedAt?: number;
  receivedAt: number;
  sourceCapturedAt?: number;
  decodeMs: number;
  header: DepthFrameHeader;
  width: number;
  height: number;
  depth: Float32Array;
  colors: Uint8Array | null;
};
export class WindowDepthDecoder {
  location: BlockLocation | null = null;
  lastTimeTag = -1;
  repeats = 0;
  failures: Record<string, number> = {};
  lastFailure: string | null = null;
  decodeMs = 0;
  decoded = 0;
  constructor(public grid = 128, public foregroundGrid = 0) {}
  decode(frame: WindowFrame): RawDepthFrame | null {
    const started = performance.now();
    const image = { width: frame.width, height: frame.height, data: frame.data, channels: 4 };
    let result = decodeImage(image, this.location ?? undefined);
    if (!result.ok && this.location) result = decodeImage(image);
    this.location = result.ok ? result.location : null;
    const decodeMs = performance.now() - started;
    this.decodeMs = this.decodeMs * 0.9 + decodeMs * 0.1;
    if (!result.ok) {
      this.lastFailure = result.detail ? `${result.reason}: ${result.detail}` : result.reason;
      this.failures[result.reason] = (this.failures[result.reason] ?? 0) + 1;
      return null;
    }
    this.lastFailure = null;
    const { header, layout, depth } = result.frame;
    if (header.timeTag === this.lastTimeTag) {
      this.repeats++;
      return null;
    }
    this.lastTimeTag = header.timeTag;
    this.decoded++;
    const width = Math.min(this.grid, layout.depthWidth),
      height = Math.min(this.grid, layout.depthHeight);
    const foregroundWidth = Math.min(this.foregroundGrid, layout.depthWidth);
    const foregroundHeight = Math.min(this.foregroundGrid, layout.depthHeight);
    return {
      receivedAt: frame.receivedAt,
      sourceCapturedAt: frame.sourceCapturedAt,
      decodeMs,
      header,
      width,
      height,
      depth: downsampleDepth(depth, layout.depthWidth, layout.depthHeight, width, height),
      foreground: this.foregroundGrid > 0
        ? {
          width: foregroundWidth,
          height: foregroundHeight,
          depth: foregroundWidth === layout.depthWidth && foregroundHeight === layout.depthHeight
            ? depth
            : downsampleDepth(
              depth,
              layout.depthWidth,
              layout.depthHeight,
              foregroundWidth,
              foregroundHeight,
            ),
        }
        : undefined,
      // Colours come from the window at the samples: only where the window shows the depth's view.
      colors: header.flags & FLAG_VRCHAT_CAMERA && !(header.flags & FLAG_DEPTH_CAMERA) &&
          frame.width === Math.round(header.screenWidth) &&
          frame.height === Math.round(header.screenHeight)
        ? sampleColors(frame, width, height, result.location, layout)
        : null,
    };
  }
}
export function depthFrameToWire(
  frame: RawDepthFrame,
  worldScale: number | null,
  { colors = true }: { colors?: boolean } = {},
): VrcDepthFramePayload {
  const codes = encodeDepthLog16(frame.depth);
  return {
    receivedAt: frame.receivedAt,
    decodeMs: frame.decodeMs,
    header: frame.header,
    width: frame.width,
    height: frame.height,
    depthLog16Base64: encodeBytesBase64(new Uint8Array(codes.buffer)),
    colorBase64: colors && frame.colors ? encodeBytesBase64(frame.colors) : null,
    worldScale,
  };
}

/**
 * The window's colour at each depth sample's centre, RGBA; alpha 0 where the block itself (with
 * its quiet zone) covers the image.
 */
function sampleColors(
  frame: WindowFrame,
  width: number,
  height: number,
  location: BlockLocation,
  layout: { gridWidth: number; gridHeight: number },
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const pad = QUIET_CELLS * location.pitch;
  const x0 = location.x0 - pad, y0 = location.y0 - pad;
  const x1 = location.x0 + layout.gridWidth * location.pitch + pad;
  const y1 = location.y0 + layout.gridHeight * location.pitch + pad;
  for (let j = 0; j < height; j++) {
    const y = Math.min(frame.height - 1, Math.floor((j + 0.5) * frame.height / height));
    for (let i = 0; i < width; i++) {
      const x = Math.min(frame.width - 1, Math.floor((i + 0.5) * frame.width / width));
      const o = (j * width + i) * 4;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const p = (y * frame.width + x) * 4;
      out[o] = frame.data[p];
      out[o + 1] = frame.data[p + 1];
      out[o + 2] = frame.data[p + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}
