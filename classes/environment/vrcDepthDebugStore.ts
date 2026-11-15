/**
 * The VRChat depth debug view (`markdown/vrchat-depth/README.md`): the latest decoded depth as
 * points in tracking space, for the scene's coloured mesh (`VrcDepthDebugMesh` in `scene.tsx`),
 * plus status lines the VRC camera layer window prints over VRChat's image.
 *
 * Written by the `webxr` actor on each `VRCDEPTHFRAME`; read every frame by the scene. Both run in
 * the webxr worker.
 */

export type VrcDepthDebugMeshData = {
  /** Grid size of `positions`. */
  width: number;
  height: number;
  /** Tracking-space points, xyz per sample, row-major from the image's top-left; NaN = none. */
  positions: Float32Array;
  /** The view's depth per sample (metres, 0 = none), to cut triangles across depth edges. */
  depth: Float32Array;
  /** Linear RGB per sample (NaN = no colour), or null for a flat colour. */
  colors: Float32Array | null;
  /** The view's position in tracking space, where every sample's ray starts. */
  origin?: readonly [number, number, number];
  /** Bumped per frame so the scene knows to re-upload. */
  revision: number;
};

/** The accumulated scan as non-indexed surfel triangles in VRChat world space. */
export type VrcDepthScanData = {
  positions: Float32Array;
  /** Linear RGB per vertex. */
  colors: Float32Array;
  count: number;
  revision: number;
};

let mesh: VrcDepthDebugMeshData | null = null;
let scan: VrcDepthScanData | null = null;
let meshRevision = 0;
let scanRevision = 0;
/** VRChat world → tracking for the scan mesh: `scale · R_y(yawRad) · p + translation`. */
let scanAlignment: { yawRad: number; scale: number; translation: [number, number, number] } | null =
  null;
let lines: string[] = [];
let enabled = false;
/** VRChat's depth hides PetPlay's objects behind VRChat's surfaces in the headset. */
let occlusion = true;
/** The GPU occluder (`headsetDepthSource.ts`) is drawing: the CPU-built one stands down. */
let gpuOcclusion = false;
/** VRChat's Stream camera is pinned to the head (`headCamera.ts`): camera markers would sit in the face. */
let headCameraPinned = false;

export const vrcDepthDebugStore = {
  mesh: () => (enabled ? mesh : null),
  /** Desktop depth debugger consumes live data regardless of headset debug visibility. */
  rawMesh: () => mesh,
  setMesh(next: Omit<VrcDepthDebugMeshData, "revision"> | null) {
    mesh = next ? { ...next, revision: ++meshRevision } : null;
  },
  // --mesh controls the live surface. Pausing a scan retains its accumulated geometry.
  scan: () => scan,
  setScan(next: Omit<VrcDepthScanData, "revision"> | null) {
    scan = next ? { ...next, revision: ++scanRevision } : null;
  },
  scanAlignment: () => scanAlignment,
  setScanAlignment(next: typeof scanAlignment) {
    scanAlignment = next;
  },
  lines: () => lines,
  setLines(next: string[]) {
    lines = next;
  },
  headCameraPinned: () => headCameraPinned,
  setHeadCameraPinned(on: boolean) {
    headCameraPinned = on;
  },
  gpuOcclusion: () => gpuOcclusion,
  setGpuOcclusion(on: boolean) {
    gpuOcclusion = on;
  },
  occlusion: () => occlusion,
  setOcclusion(on: boolean) {
    occlusion = on;
  },
  enabled: () => enabled,
  setEnabled(on: boolean) {
    enabled = on;
  },
};
