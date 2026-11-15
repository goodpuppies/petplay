import * as THREE from "three";
import { applyWorldToTracking, cameraWorldPose, type WorldToTracking } from "./sync.ts";
import type { VrcDepthDebugFrame } from "./debugView.ts";

/**
 * The depth block still inside VRChat's window texture (`gpuWindowCapture.ts`): the foreground
 * shader decodes each sample it needs from the window's pixels, so no depth plane is decoded on the
 * CPU or uploaded.
 */
export type DepthForegroundBlock = {
  /** GL texture of the VRChat window, row 0 at the top. */
  textureId: number;
  textureWidth: number;
  textureHeight: number;
  /** Block top-left and cell pitch in window pixels. */
  x0: number;
  y0: number;
  pitch: number;
  gridWidth: number;
  dataStartRow: number;
  /** Data cell of depth sample 0 (`DerivedLayout.depthStartCell`); one cell per sample. */
  depthStartCell: number;
  bits: readonly [number, number, number];
  depthWidth: number;
  depthHeight: number;
  /** Log depth range (`format.ts` `quantizeDepth`), metres. */
  depthRef: number;
  depthFar: number;
  /** Byte -> level per channel, 3 × 256 (`DecodeResult.luts`). */
  luts: Uint8Array;
  /** 3D calibration: the classifier's lookup table (`ColorClassifier.shaderTable`). */
  table3d?: Table3d;
};

export type Table3d = {
  data: Uint8Array;
  width: number;
  height: number;
  /** Bins a channel, and slices tiled across. */
  size: number;
  tiles: number;
  revision: number;
};

export type DepthForeground = {
  /** Decoded plane; ignored when `block` is set. */
  depth: Float32Array;
  width: number;
  height: number;
  revision: number;
  /** VRChat world units -> PetPlay tracking metres. */
  scale: number;
  biasMeters?: number;
  block?: DepthForegroundBlock;
};

/** Same captured camera/projection as the depth pixels, transformed into PetPlay's space. */
export function foregroundCamera(frame: VrcDepthDebugFrame, alignment: WorldToTracking) {
  const pose = applyWorldToTracking(alignment, cameraWorldPose(frame.header));
  const world = new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.position),
    new THREE.Quaternion(...pose.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
  const p = frame.header.projection;
  const near = 0.03, far = 500;
  const projection = new THREE.Matrix4().set(
    p.m00,
    0,
    -p.m02,
    0,
    0,
    Math.abs(p.m11),
    -p.m12 * Math.sign(p.m11 || 1),
    0,
    0,
    0,
    -(far + near) / (far - near),
    -2 * far * near / (far - near),
    0,
    0,
    -1,
    0,
  );
  return {
    viewMatrix: new Float32Array(world.invert().elements),
    projectionMatrix: new Float32Array(projection.elements),
  };
}

/**
 * The depth block's samples straight from VRChat's window texture (`format.ts` layout): texture0
 * the window, texture1 the 1D calibration LUT, texture2 the 3D table; `fetchDepth(p)` is sample
 * `p` of the block's depth plane in metres, 0 = none. Shared by the foreground and the occluder.
 */
const BLOCK_FETCH = `uniform sampler2D texture0; // VRChat's window
uniform sampler2D texture1; // calibration: byte -> level / 255, one row per channel
uniform vec4 uBlock;  // x0, y0, pitch, gridWidth
uniform vec4 uLayout; // dataStartRow, depthWidth, depthHeight, depthRef (log depth near)
uniform vec4 uBits;   // bits R, G, B; data cell of depth sample 0
uniform sampler2D texture2; // 3D calibration table (ColorClassifier.shaderTable)
uniform vec4 uCal;    // x: 3D calibration on, y: bins a channel, z: slices tiled across, w: ln(far / near)
ivec2 depthSize() { return ivec2(uLayout.yz); }
int level(float v, int channel) {
  return int(texelFetch(texture1, ivec2(int(v * 255.0 + 0.5), channel), 0).r * 255.0 + 0.5);
}
uint cellBits(int cell) {
  int gridWidth = int(uBlock.w);
  vec2 centre = vec2(float(cell % gridWidth), uLayout.x + float(cell / gridWidth)) + 0.5;
  vec3 c = texelFetch(texture0, ivec2(floor(uBlock.xy + centre * uBlock.z)), 0).rgb;
  int bR = int(uBits.x), bG = int(uBits.y);
  if (uCal.x > 0.5) {
    // Nearest calibrated colour, through the observed-colour bins.
    int size = int(uCal.y), tiles = int(uCal.z);
    ivec3 bin = min(ivec3(c * 255.0 + 0.5) * size / 256, ivec3(size - 1));
    ivec2 at = ivec2((bin.b % tiles) * size + bin.r, (bin.b / tiles) * size + bin.g);
    ivec3 l = ivec3(texelFetch(texture2, at, 0).rgb * 255.0 + 0.5);
    return uint(l.r | (l.g << bR) | (l.b << (bR + bG)));
  }
  return uint(level(c.r, 0) | (level(c.g, 1) << bR) | (level(c.b, 2) << (bR + bG)));
}
// format.ts: one cell per sample, log depth over the cell's bits (quantizeDepth).
float fetchDepth(ivec2 p) {
  uint q = cellBits(int(uBits.w) + p.y * int(uLayout.y) + p.x);
  if (q == 0u) return 0.0;
  float steps = exp2(uBits.x + uBits.y + uBits.z) - 2.0;
  return uLayout.w * exp(float(q - 1u) / steps * uCal.w);
}`;

export const FOREGROUND_VERTEX = `#version 330
in vec3 vertexPosition;
void main() { gl_Position = vec4(vertexPosition.xy * 2.0, 0.0, 1.0); }
`;
const DEPTH_FILTER = `float foregroundDepth(vec2 uv) {
  ivec2 size = depthSize();
  vec2 p = uv * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(p));
  ivec2 hi = size - ivec2(1);
  vec4 d = vec4(
    fetchDepth(clamp(base, ivec2(0), hi)),
    fetchDepth(clamp(base + ivec2(1, 0), ivec2(0), hi)),
    fetchDepth(clamp(base + ivec2(0, 1), ivec2(0), hi)),
    fetchDepth(clamp(base + ivec2(1, 1), ivec2(0), hi)));
  float lo = min(min(d.x, d.y), min(d.z, d.w));
  float high = max(max(d.x, d.y), max(d.z, d.w));
  // Smooth continuous surfaces, but never blend across missing samples or large depth edges.
  if (lo > 0.0 && high - lo <= 0.06 * lo) {
    vec2 f = fract(p);
    vec4 weights = vec4((1.0-f.x)*(1.0-f.y), f.x*(1.0-f.y), (1.0-f.x)*f.y, f.x*f.y);
    // Reciprocal eye depth is linear over a projected plane; eye depth itself is not.
    return 1.0 / dot(weights, 1.0 / d);
  }
  return fetchDepth(clamp(ivec2(floor(uv * vec2(size))), ivec2(0), hi));
}`;

function foregroundFragment(
  source: "texture" | "block",
  pass: "depth" | "shadow" = "depth",
): string {
  const fetch = source === "texture"
    ? `uniform sampler2D texture0;
ivec2 depthSize() { return textureSize(texture0, 0); }
float fetchDepth(ivec2 p) { return texelFetch(texture0, p, 0).r; }`
    : BLOCK_FETCH;
  return `#version 330
${fetch}
// projection[10], projection[14], viewport width, viewport height
uniform vec4 uProjection;
// world-to-tracking scale, positive depth bias in tracking metres
uniform vec4 uDepth;
out vec4 finalColor;
${DEPTH_FILTER}
${pass === "depth" ? DEPTH_MAIN : SHADOW_MAIN}`;
}

const DEPTH_MAIN = `void main() {
  vec2 uv = gl_FragCoord.xy / uProjection.zw;
  // Source depth rows run top to bottom; OpenGL fragment coordinates run bottom to top.
  float raw = foregroundDepth(vec2(uv.x, 1.0 - uv.y));
  if (!(raw > 0.0)) discard;
  float d = raw * uDepth.x + uDepth.y;
  gl_FragDepth = clamp(0.5 * (1.0 - uProjection.x + uProjection.y / d), 0.0, 1.0);
  finalColor = vec4(0.0);
}
`;

/**
 * Shadows of PetPlay's objects on VRChat's surfaces: each pixel's VRChat depth back to a tracking
 * position, into the light's view, compared with PetPlay's shadow map (packed depth, 3x3 PCF);
 * the shadowed part draws black at the shadow's strength over VRChat's image.
 */
const SHADOW_MAIN = `uniform mat4 uInvView;     // camera -> tracking
uniform vec4 uProjXY;      // projection[0], [5], [8], [9]
uniform mat4 uLightMatrix; // tracking -> light clip (orthographic)
uniform sampler2D texture3; // shadow map: light-space depth packed in RGBA8
uniform vec4 uShadow;      // strength, texel size, depth bias, unused
float unpackDepth(vec4 c) { return dot(c.rgb, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0)); }
void main() {
  vec2 uv = gl_FragCoord.xy / uProjection.zw;
  float raw = foregroundDepth(vec2(uv.x, 1.0 - uv.y));
  if (!(raw > 0.0)) discard;
  float d = raw * uDepth.x;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 view = vec3(d * (ndc.x + uProjXY.z) / uProjXY.x, d * (ndc.y + uProjXY.w) / uProjXY.y, -d);
  vec4 clip = uLightMatrix * (uInvView * vec4(view, 1.0));
  vec3 l = clip.xyz / clip.w * 0.5 + 0.5;
  if (any(lessThan(l, vec3(0.0))) || any(greaterThan(l, vec3(1.0)))) discard;
  float blocked = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float caster = unpackDepth(texture(texture3, l.xy + vec2(x, y) * uShadow.y));
      blocked += l.z - uShadow.z > caster ? 1.0 : 0.0;
    }
  }
  blocked /= 9.0;
  if (blocked <= 0.0) discard;
  finalColor = vec4(0.0, 0.0, 0.0, blocked * uShadow.x);
}
`;

export const FOREGROUND_FRAGMENT = foregroundFragment("texture");
/** Decodes the depth block from VRChat's window texture per fragment (`DepthForeground.block`). */
export const FOREGROUND_BLOCK_FRAGMENT = foregroundFragment("block");
/** PetPlay's shadows on VRChat's surfaces, from either depth source. */
export const SHADOW_FRAGMENT = foregroundFragment("texture", "shadow");
export const SHADOW_BLOCK_FRAGMENT = foregroundFragment("block", "shadow");

/** The shadow map pass: light-space depth packed into RGBA8 (unpacked by `SHADOW_MAIN`). */
export const SHADOW_CASTER_VERTEX = `#version 330
in vec3 vertexPosition;
uniform mat4 mvp;
void main() { gl_Position = mvp * vec4(vertexPosition, 1.0); }
`;
export const SHADOW_CASTER_FRAGMENT = `#version 330
out vec4 finalColor;
void main() {
  vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * gl_FragCoord.z);
  enc.xy -= enc.yz / 255.0;
  // Alpha must be opaque: the caller's normal blend state must not alter packed depth.
  finalColor = vec4(enc, 1.0);
}
`;

/**
 * VR occluder (`markdown/vrchat-depth/cpu-gpu-audit.md`): a fixed grid of unshared triangles over
 * the block's depth plane, decoded and unprojected in the vertex shader. Each vertex carries its
 * quad (x, y) and corner code (z: 0..2 the quad's first triangle a, c, b; 3..5 the second b, c, d),
 * decodes its triangle's three samples. A triangle with a missing sample collapses; one across a
 * depth edge (not within 6 %: `updateOccluderSurface`'s rule) is placed at its farthest sample, so
 * the background closes up under silhouettes. Samples are the nearest-sampled grid
 * `decodeImage({ depthGrid })` gives the CPU; unprojection as `unprojectDepth`.
 */
export const OCCLUDER_VERTEX = `#version 330
${BLOCK_FETCH}
in vec3 vertexPosition;
uniform mat4 mvp;
uniform mat4 uCameraToTracking; // VRChat camera space (world units) -> tracking metres
uniform vec4 uProj;             // m00, |m11|, m02, m12 · sign(m11)
uniform vec4 uGrid;             // grid width, grid height, bias along the ray (camera units), unused
float gridDepth(ivec2 g) {
  ivec2 size = ivec2(uLayout.yz);
  ivec2 s = min(ivec2((vec2(g) + 0.5) * vec2(size) / uGrid.xy), size - ivec2(1));
  return fetchDepth(s);
}
bool joined(float a, float b) { return a > 0.0 && b > 0.0 && abs(a - b) < 0.06 * min(a, b); }
void main() {
  ivec2 q = ivec2(vertexPosition.xy);
  int code = int(vertexPosition.z + 0.5);
  ivec2 c0 = code < 3 ? q : q + ivec2(1, 0);
  ivec2 c1 = q + ivec2(0, 1);
  ivec2 c2 = code < 3 ? q + ivec2(1, 0) : q + ivec2(1, 1);
  float d0 = gridDepth(c0), d1 = gridDepth(c1), d2 = gridDepth(c2);
  if (!(d0 > 0.0 && d1 > 0.0 && d2 > 0.0)) {
    // A missing sample: all three corners land on one point outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  int k = code % 3;
  ivec2 g = k == 0 ? c0 : (k == 1 ? c1 : c2);
  float d = k == 0 ? d0 : (k == 1 ? d1 : d2);
  // Across a depth edge the triangle takes its farthest sample's depth: the background then runs
  // under the foreground's silhouette instead of leaving a cell-wide gap there, and nothing in
  // front of the background is hidden by it.
  if (!(joined(d0, d1) && joined(d0, d2) && joined(d1, d2))) d = max(d0, max(d1, d2));
  vec2 ndc = vec2(2.0 * (float(g.x) + 0.5) / uGrid.x - 1.0, 1.0 - 2.0 * (float(g.y) + 0.5) / uGrid.y);
  vec3 p = vec3((ndc.x - uProj.z) * d / uProj.x, (ndc.y - uProj.w) * d / uProj.y, -d);
  p *= 1.0 + uGrid.z / length(p);
  gl_Position = mvp * (uCameraToTracking * vec4(p, 1.0));
}
`;

export const OCCLUDER_FRAGMENT = `#version 330
out vec4 finalColor;
void main() { finalColor = vec4(0.0); }
`;

/** Full-plane stereo occluder: inverse-reproject each eye ray into the captured depth image.
 * Fixed-point refinement accounts for the eye/capture-camera offset without a coarse mesh.
 * Missing depth, out-of-view rays and unconverged silhouette samples leave the overlay clear.
 */
export const OCCLUDER_PIXEL_FRAGMENT = `#version 330
${BLOCK_FETCH}
${DEPTH_FILTER}
uniform mat4 uEyeToCamera;
uniform vec4 uEye;        // target eye projection: m00, m11, m02, m12
uniform vec4 uProj;       // captured camera projection: m00, |m11|, offset x/y
uniform vec4 uViewport;   // GL viewport x, y, width, height
uniform vec4 uEyeDepth;   // target projection[10], [14], tracking-space bias along the ray
out vec4 finalColor;
vec2 cameraUv(vec3 p) {
  vec2 ndc = uProj.xy * p.xy / -p.z + uProj.zw;
  return vec2(ndc.x + 1.0, 1.0 - ndc.y) * 0.5;
}
bool inImage(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))); }
void main() {
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec3 eyeRay = vec3((ndc + uEye.zw) / uEye.xy, -1.0);
  vec3 origin = (uEyeToCamera * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 direction = mat3(uEyeToCamera) * eyeRay;
  if (direction.z >= -0.000001) discard;
  vec2 uv = cameraUv(direction);
  float t = 0.0;
  vec2 previous;
  for (int i = 0; i < 3; i++) {
    if (!inImage(uv)) discard;
    float d = foregroundDepth(uv);
    if (!(d > 0.0)) discard;
    t = (-d - origin.z) / direction.z;
    if (!(t > 0.0)) discard;
    previous = uv;
    uv = cameraUv(origin + direction * t);
  }
  // Large reprojection disagreement is a disocclusion, not trustworthy foreground depth.
  if (!inImage(uv) || any(greaterThan(abs(uv - previous) * vec2(depthSize()), vec2(2.0)))) discard;
  t += uEyeDepth.z / length(eyeRay);
  gl_FragDepth = clamp(0.5 * (1.0 - uEyeDepth.x + uEyeDepth.y / t), 0.0, 1.0);
  finalColor = vec4(0.0);
}
`;
