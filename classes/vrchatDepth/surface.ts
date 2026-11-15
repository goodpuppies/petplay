import * as THREE from "three";
import type { VrcDepthDebugMeshData } from "../environment/vrcDepthDebugStore.ts";

/** Standard Three triangle geometry, with discontinuities cut rather than bridged. */
export function updateDepthSurface(
  geometry: THREE.BufferGeometry,
  data: VrcDepthDebugMeshData,
  shading: "color" | "depth" = "color",
): void {
  const { width, height, positions, depth, colors } = data;
  const count = width * height;
  if (geometry.getAttribute("position")?.count !== count) {
    // Versions must keep advancing when replacing attributes: raythree caches by their sum.
    const revision = [
      geometry.getAttribute("position"),
      geometry.getAttribute("color"),
      geometry.getIndex(),
    ]
      .reduce(
        (sum, attribute) => sum + ((attribute as THREE.BufferAttribute | undefined)?.version ?? 0),
        0,
      );
    for (const name of ["position", "color"]) {
      const attribute = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      attribute.version = revision + 1;
      geometry.setAttribute(name, attribute);
    }
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint32Array((width - 1) * (height - 1) * 6), 1),
    );
  }
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const color = geometry.getAttribute("color") as THREE.BufferAttribute;
  const index = geometry.getIndex()!;
  const p = position.array as Float32Array, col = color.array as Float32Array;
  const tint = new THREE.Color();
  let fallback = 0;
  while (fallback < count && !(depth[fallback] > 0)) fallback++;
  for (let k = 0; k < count; k++) {
    const src = depth[k] > 0 ? k : Math.min(fallback, count - 1);
    for (let axis = 0; axis < 3; axis++) p[k * 3 + axis] = positions[src * 3 + axis] || 0;
    const hasColor = colors != null && Number.isFinite(colors[k * 3]);
    if (shading === "depth") {
      const d = Math.max(0, depth[k]);
      tint.setHSL(0.65 * Math.min(1, Math.log1p(d) / Math.log(13)), 0.85, 0.5);
      col.set([tint.r, tint.g, tint.b], k * 3);
    } else {
      col[k * 3] = hasColor ? colors![k * 3] : 0.04;
      col[k * 3 + 1] = hasColor ? colors![k * 3 + 1] : 0.8;
      col[k * 3 + 2] = hasColor ? colors![k * 3 + 2] : 1;
    }
  }
  const joined = (a: number, b: number) =>
    depth[a] > 0 && depth[b] > 0 &&
    Math.abs(depth[a] - depth[b]) < 0.06 * Math.min(depth[a], depth[b]);
  const idx = index.array as Uint32Array;
  let t = 0;
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const a = j * width + i, b = a + 1, c = a + width, d = c + 1;
      const first = joined(a, b) && joined(a, c) && joined(b, c);
      const second = joined(b, d) && joined(c, d) && joined(b, c);
      idx[t++] = first ? a : 0;
      idx[t++] = first ? c : 0;
      idx[t++] = first ? b : 0;
      idx[t++] = second ? b : 0;
      idx[t++] = second ? c : 0;
      idx[t++] = second ? d : 0;
    }
  }
  position.needsUpdate = color.needsUpdate = index.needsUpdate = true;
  geometry.computeBoundingSphere();
}

/**
 * The depth surface as an occluder: positions and a 16-bit index only (no colours, normals or
 * bounds; the mesh is drawn unculled), every vertex pushed `biasMeters` further along its ray from
 * `data.origin` so PetPlay objects resting on a VRChat surface aren't cut by it. Rebuilt for every
 * decoded block, so it stays one tight pass: the coloured `updateDepthSurface` cost about 14 ms.
 */
export function updateOccluderSurface(
  geometry: THREE.BufferGeometry,
  data: VrcDepthDebugMeshData,
  biasMeters: number,
): void {
  const { width, height, positions, depth } = data;
  const count = width * height;
  const indexCount = (width - 1) * (height - 1) * 6;
  if (geometry.getAttribute("position")?.count !== count) {
    // Versions must keep advancing when replacing attributes: raythree caches by their sum.
    const revision =
      ((geometry.getAttribute("position") as THREE.BufferAttribute | undefined)?.version ?? 0) +
      (geometry.getIndex()?.version ?? 0);
    const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    position.version = revision + 1;
    geometry.setAttribute("position", position);
    const index = new THREE.BufferAttribute(
      count <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount),
      1,
    );
    index.version = revision + 1;
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  }
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex()!;
  const p = position.array as Float32Array;
  const o = data.origin ?? [0, 0, 0];
  const bias = biasMeters > 0 && data.origin ? biasMeters : 0;
  let fallback = 0;
  while (fallback < count && !(depth[fallback] > 0)) fallback++;
  fallback = Math.min(fallback, count - 1);
  for (let k = 0; k < count; k++) {
    const src = (depth[k] > 0 ? k : fallback) * 3;
    const x = positions[src] || 0, y = positions[src + 1] || 0, z = positions[src + 2] || 0;
    const dx = x - o[0], dy = y - o[1], dz = z - o[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const grow = bias > 0 && length > 1e-6 ? bias / length : 0;
    p[k * 3] = x + dx * grow;
    p[k * 3 + 1] = y + dy * grow;
    p[k * 3 + 2] = z + dz * grow;
  }
  const idx = index.array as Uint16Array | Uint32Array;
  let t = 0;
  for (let j = 0; j < height - 1; j++) {
    for (let i = 0; i < width - 1; i++) {
      const a = j * width + i, b = a + 1, c = a + width, d = c + 1;
      const da = depth[a], db = depth[b], dc = depth[c], dd = depth[d];
      const bc = joined(db, dc);
      if (bc && joined(da, db) && joined(da, dc)) {
        idx[t] = a, idx[t + 1] = c, idx[t + 2] = b;
      } else idx[t] = idx[t + 1] = idx[t + 2] = 0;
      if (bc && joined(db, dd) && joined(dc, dd)) {
        idx[t + 3] = b, idx[t + 4] = c, idx[t + 5] = d;
      } else idx[t + 3] = idx[t + 4] = idx[t + 5] = 0;
      t += 6;
    }
  }
  position.needsUpdate = index.needsUpdate = true;
}

/** Two samples on one surface: both valid and within 6 % of each other (`updateDepthSurface`). */
function joined(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) < 0.06 * Math.min(a, b);
}
