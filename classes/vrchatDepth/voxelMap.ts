/**
 * A sparse voxel scan of VRChat's world from successive depth blocks
 * (`markdown/vrchat-depth/README.md`). Cells live in VRChat world coordinates (right-handed, see
 * `sync.ts`), so the scan stays put through locomotion, turning and avatar scaling; the current
 * world → tracking alignment places it when the surfel mesh is built.
 *
 * Each integration adds the frame's samples (averaging position, colour and the direction they
 * were seen from per cell) and carves: a cell the camera now sees through, well in front of the
 * observed depth, loses confidence and is dropped once misses outweigh hits. That clears people
 * and objects that moved away.
 */
import type { Quat, Vec3 } from "../vrcCameraCalibration.ts";
import { rotateVec, type WorldToTracking } from "./sync.ts";

export type VoxelCell = {
  /** Running mean of the samples, world metres. */
  x: number;
  y: number;
  z: number;
  /** Linear colour, 0..1. */
  r: number;
  g: number;
  b: number;
  /** Mean direction from the surface back to the cameras that saw it (unnormalized). */
  nx: number;
  ny: number;
  nz: number;
  hits: number;
  misses: number;
  lastSeen: number;
};

export type VoxelFrame = {
  /** The view's right-handed world pose (looking down −z), as `cameraWorldPose`. */
  cameraPosition: Vec3;
  cameraQuaternion: Quat;
  /** View-space points from `unprojectDepth` (world units), NaN where there is no depth. */
  points: Float32Array;
  /** The view's depth per sample (metres, 0 = none): carving compares against it. */
  depth: Float32Array;
  width: number;
  height: number;
  projection: { m00: number; m11: number; m02: number; m12: number };
  /** Linear RGB per sample, 0..1, or null for no colour (grey). NaN marks no colour too. */
  colors: Float32Array | null;
  now: number;
};

const OFFSET = 65536;
const SPAN = 131072;
/** At most this much weight in a cell's running mean, so it keeps following slow changes. */
const MAX_WEIGHT = 30;

export class VoxelMap {
  readonly cells = new Map<number, VoxelCell>();
  revision = 0;

  constructor(
    /** Cell size, world metres. */
    public cellSize = 0.04,
    public maxCells = 40000,
    /** Integrate every `stride`-th sample in each direction. */
    public stride = 2,
    /** Samples further than this (world metres) are skipped: too coarse to be useful. */
    public maxDistance = 12,
  ) {}

  private key(x: number, y: number, z: number): number {
    const s = this.cellSize;
    const ix = Math.floor(x / s) + OFFSET, iy = Math.floor(y / s) + OFFSET;
    const iz = Math.floor(z / s) + OFFSET;
    return (ix * SPAN + iy) * SPAN + iz;
  }

  clear(): void {
    this.cells.clear();
    this.revision++;
  }

  integrate(frame: VoxelFrame): void {
    this.carve(frame);
    const { points, width, height, colors, now } = frame;
    const q = frame.cameraQuaternion, c = frame.cameraPosition;
    const stride = Math.max(1, this.stride);
    for (let j = 0; j < height; j += stride) {
      for (let i = 0; i < width; i += stride) {
        const k = j * width + i;
        const vx = points[k * 3], vy = points[k * 3 + 1], vz = points[k * 3 + 2];
        if (Number.isNaN(vx) || -vz > this.maxDistance) continue;
        const w = rotateVec(q, [vx, vy, vz]);
        const x = w[0] + c[0], y = w[1] + c[1], z = w[2] + c[2];
        const key = this.key(x, y, z);
        let cell = this.cells.get(key);
        // Direction back to the camera, normalized.
        const len = Math.hypot(w[0], w[1], w[2]) || 1;
        const dx = -w[0] / len, dy = -w[1] / len, dz = -w[2] / len;
        const cr = colors ? colors[k * 3] : NaN;
        const hasColor = !Number.isNaN(cr);
        if (!cell) {
          cell = {
            x,
            y,
            z,
            r: hasColor ? cr : 0.5,
            g: hasColor ? colors![k * 3 + 1] : 0.5,
            b: hasColor ? colors![k * 3 + 2] : 0.5,
            nx: dx,
            ny: dy,
            nz: dz,
            hits: 1,
            misses: 0,
            lastSeen: now,
          };
          this.cells.set(key, cell);
          continue;
        }
        const weight = Math.min(cell.hits, MAX_WEIGHT);
        const a = 1 / (weight + 1);
        cell.x += (x - cell.x) * a;
        cell.y += (y - cell.y) * a;
        cell.z += (z - cell.z) * a;
        if (hasColor) {
          cell.r += (cr - cell.r) * a;
          cell.g += (colors![k * 3 + 1] - cell.g) * a;
          cell.b += (colors![k * 3 + 2] - cell.b) * a;
        }
        cell.nx += (dx - cell.nx) * a;
        cell.ny += (dy - cell.ny) * a;
        cell.nz += (dz - cell.nz) * a;
        // Bound confidence as well as averaging weight: a wall observed for minutes must not
        // take minutes to disappear when a door opens or an avatar moves away.
        cell.hits = Math.min(cell.hits + 1, MAX_WEIGHT);
        cell.misses = 0;
        cell.lastSeen = now;
      }
    }
    this.evict();
    this.revision++;
  }

  /** Cells the view now sees through (well in front of its observed depth) lose confidence. */
  private carve(frame: VoxelFrame): void {
    const { depth, width, height, projection } = frame;
    const m00 = projection.m00, m02 = projection.m02;
    const m11 = Math.abs(projection.m11);
    const m12 = projection.m12 * Math.sign(projection.m11 || 1);
    const qi: Quat = [
      -frame.cameraQuaternion[0],
      -frame.cameraQuaternion[1],
      -frame.cameraQuaternion[2],
      frame.cameraQuaternion[3],
    ];
    const c = frame.cameraPosition;
    for (const [key, cell] of this.cells) {
      const v = rotateVec(qi, [cell.x - c[0], cell.y - c[1], cell.z - c[2]]);
      const d = -v[2];
      if (d <= 0.05) continue;
      const ndcX = v[0] * m00 / d + m02, ndcY = v[1] * m11 / d + m12;
      if (ndcX <= -1 || ndcX >= 1 || ndcY <= -1 || ndcY >= 1) continue;
      const i = Math.floor((ndcX + 1) / 2 * width);
      const j = Math.floor((1 - ndcY) / 2 * height);
      const observed = depth[j * width + i];
      // Nothing there (sky) or the surface is well behind the cell: the cell is empty space.
      const margin = Math.max(2 * this.cellSize, 0.03 * d);
      if (!(observed > 0) || observed > d + margin) {
        cell.misses++;
        if (cell.misses > cell.hits) this.cells.delete(key);
      }
    }
  }

  private evict(): void {
    const excess = this.cells.size - this.maxCells;
    if (excess <= 0) return;
    const oldest = [...this.cells.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < excess; i++) this.cells.delete(oldest[i][0]);
  }

  /**
   * One square surfel per cell, a cell wide, facing the cameras that saw it, in tracking space
   * under `toTracking`. Non-indexed triangles: `positions` xyz and `colors` rgb (linear) per vertex.
   */
  buildSurfels(
    toTracking: WorldToTracking,
    minHits = 2,
  ): { positions: Float32Array; colors: Float32Array; count: number } {
    let count = 0;
    for (const cell of this.cells.values()) if (cell.hits >= minHits) count++;
    const positions = new Float32Array(count * 18);
    const colors = new Float32Array(count * 18);
    const cos = Math.cos(toTracking.yawRad), sin = Math.sin(toTracking.yawRad);
    const s = toTracking.scale, t = toTracking.translation;
    const half = this.cellSize / 2;
    let o = 0;
    for (const cell of this.cells.values()) {
      if (cell.hits < minHits) continue;
      // Normal and a tangent basis in world space.
      let nx = cell.nx, ny = cell.ny, nz = cell.nz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl, ny /= nl, nz /= nl;
      // u = normalize(up × n), or x × n near vertical.
      let ux = Math.abs(ny) < 0.9 ? nz : 0, uy = Math.abs(ny) < 0.9 ? 0 : -nz;
      let uz = Math.abs(ny) < 0.9 ? -nx : ny;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul, uy /= ul, uz /= ul;
      const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ];
      for (const [a, b] of corners) {
        const wx = cell.x + (ux * a + vx * b) * half;
        const wy = cell.y + (uy * a + vy * b) * half;
        const wz = cell.z + (uz * a + vz * b) * half;
        positions[o] = s * (cos * wx + sin * wz) + t[0];
        positions[o + 1] = s * wy + t[1];
        positions[o + 2] = s * (-sin * wx + cos * wz) + t[2];
        colors[o] = cell.r;
        colors[o + 1] = cell.g;
        colors[o + 2] = cell.b;
        o += 3;
      }
    }
    return { positions, colors, count };
  }
}
