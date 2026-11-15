/**
 * Fits the depth block to VRChat's camera and window (`markdown/vrchat-depth/README.md`). VRChat
 * renders its camera at the Stream resolution and shows it scaled in its desktop window, which is
 * what the capture reads. At exactly 1:1 a cell can be one pixel; otherwise the window resamples
 * the block, and a cell needs at least `MIN_WINDOW_PITCH` window pixels to survive (2.3 px cells
 * decode in the lab, sub-pixel ones can't). Bigger cells mean a smaller grid and depth plane, so
 * the block still fits the camera image.
 *
 * Pure; the intake applies the result over OSC (`blockLayout.ts` tunables).
 */
import { type ChannelBits, deriveLayout } from "./format.ts";

export type BlockFit = { cellPx: number; gridWidth: number; depthSize: number };
export type Size = { width: number; height: number };

/** Window pixels a cell needs when the window resamples VRChat's camera image. */
export const MIN_WINDOW_PITCH = 2;
/** The block's share of the camera image's height: it covers that part of VRChat's view. */
export const BLOCK_MAX_HEIGHT_FRACTION = 0.35;
/** The block's top-left in camera pixels (`DEFAULT_LAYOUT.originX/Y`). */
export const BLOCK_ORIGIN = 8;
const CELL_PX = { min: 1, max: 9 };
const GRID_WIDTH = { min: 64, max: 1024 };
const DEPTH_SIZE = { min: 16, max: 512, step: 16 };

/** Window pixels per camera pixel: the smaller axis when VRChat letterboxes the image. */
export function windowScale(camera: Size, window: Size): number {
  return Math.min(window.width / camera.width, window.height / camera.height);
}

/** Camera pixels per cell for a window shown at `scale` window pixels per camera pixel. */
export function cellPxFor(scale: number): number {
  if (Math.abs(scale - 1) < 1e-3) return 1;
  const px = Math.ceil(MIN_WINDOW_PITCH / scale - 1e-6);
  return Math.max(CELL_PX.min, Math.min(CELL_PX.max, px));
}

/**
 * The largest block that fits `camera` at the cell size `scale` needs. `mode` is the calibration
 * mode's layout (`MODE_LAYOUT`): its bits and calibration cells change the block's height.
 */
export function fitBlock(
  camera: Size,
  scale: number,
  mode: { bits: number; calibration3D: number; levelInset: number },
): BlockFit {
  const cellPx = cellPxFor(scale);
  const maxWidthCells = Math.floor((camera.width - 2 * BLOCK_ORIGIN) / cellPx);
  const gridWidth = Math.max(GRID_WIDTH.min, Math.min(GRID_WIDTH.max, maxWidthCells));
  const maxHeightCells = Math.floor(camera.height * BLOCK_MAX_HEIGHT_FRACTION / cellPx);
  const bits = [mode.bits, mode.bits, mode.bits] as unknown as ChannelBits;
  let depthSize = DEPTH_SIZE.min;
  for (let size = DEPTH_SIZE.max; size >= DEPTH_SIZE.min; size -= DEPTH_SIZE.step) {
    const layout = deriveLayout({
      bits,
      gridWidth,
      depthWidth: size,
      depthHeight: size,
      calibration3D: mode.calibration3D > 0,
      levelInset: mode.levelInset,
    });
    if (layout.gridHeight <= maxHeightCells) {
      depthSize = size;
      break;
    }
  }
  return { cellPx, gridWidth, depthSize };
}

/**
 * Window scales to try, in order, while no block decodes at all (the camera size is then unknown):
 * 1:1 first, then ever smaller windows. The camera is guessed as the window over the scale.
 */
export const PROBE_SCALES = [1, 0.75, 0.5, 0.33] as const;

export function probeFit(
  window: Size,
  step: number,
  mode: { bits: number; calibration3D: number; levelInset: number },
): BlockFit {
  const scale = PROBE_SCALES[step % PROBE_SCALES.length];
  const camera = { width: window.width / scale, height: window.height / scale };
  return fitBlock(camera, scale, mode);
}

export function sameFit(a: BlockFit, b: BlockFit): boolean {
  return a.cellPx === b.cellPx && a.gridWidth === b.gridWidth && a.depthSize === b.depthSize;
}
