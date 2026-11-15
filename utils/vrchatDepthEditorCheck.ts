/**
 * Decodes the image written by `PetPlayDepthEditorCheck` (unity/PetPlayDepth/Editor) and compares
 * it with the editor's ground truth: the camera matrix, and eye depth by raycast.
 *
 *   deno run -A utils/vrchatDepthEditorCheck.ts <directory with frame.rgba and truth.json>
 *
 * Exit code 0 when the header matches and depth agrees within tolerance.
 */
import { decodeImage, LIGHTING } from "../classes/vrchatDepth/format.ts";

const dir = Deno.args[0];
if (!dir) throw new Error("usage: vrchatDepthEditorCheck.ts <directory>");
const truth = JSON.parse(await Deno.readTextFile(`${dir}/truth.json`));
const data = await Deno.readFile(`${dir}/frame.rgba`);
const result = decodeImage({ width: truth.width, height: truth.height, data, channels: 4 });
if (!result.ok) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: result.reason,
      detail: result.detail,
      location: result.location,
    }),
  );
  Deno.exit(1);
}

const { header, depth, layout } = result.frame;
const c2w: number[] = truth.cameraToWorld;
let matrixError = 0;
for (let i = 0; i < 12; i++) {
  matrixError = Math.max(matrixError, Math.abs(header.viewToWorld[i] - c2w[i]));
}
const a2w: number[] = truth.anchorToWorld;
let anchorError = 0;
for (let i = 0; i < 12; i++) {
  anchorError = Math.max(anchorError, Math.abs(header.anchorToWorld[i] - a2w[i]));
}

const expected: number[] = truth.expectedDepth;
const errors: number[] = [];
let validityMismatches = 0;
for (let i = 0; i < expected.length; i++) {
  const e = expected[i];
  const d = depth[i];
  if ((e > 0) !== (d > 0)) {
    validityMismatches++;
    continue;
  }
  if (e > 0) errors.push(Math.abs(d - e) / e);
}
errors.sort((a, b) => a - b);
const pct = (q: number) =>
  errors.length ? errors[Math.min(errors.length - 1, Math.floor(q * errors.length))] : NaN;
// Sample centres that land on an edge can legitimately hit the other surface.
const edgeOutliers = errors.filter((e) => e > 0.01).length;

const summary = {
  ok: matrixError < 1e-5 && anchorError < 1e-4 && pct(0.5) < 0.002 &&
    validityMismatches + edgeOutliers <= expected.length * 0.03,
  graphicsDevice: truth.graphicsDevice,
  location: result.location,
  calibrationMargin: result.calibrationMargin,
  grid: `${layout.gridWidth}x${layout.gridHeight} cells, ${layout.bits.join("/")} bits`,
  flags: header.flags,
  eye: header.eye,
  screen: [header.screenWidth, header.screenHeight],
  nearFar: [header.near, header.far],
  projection: header.projection,
  truthProjection: {
    m00: truth.projection[0],
    m11: truth.projection[5],
    m02: truth.projection[2],
    m12: truth.projection[6],
  },
  viewToWorldMaxError: matrixError,
  anchorToWorldMaxError: anchorError,
  depthRelativeError: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: errors.at(-1) },
  edgeOutliers,
  validityMismatches,
  samples: expected.length,
  lighting: lightingSummary(header.lighting ?? []),
};
function lightingSummary(l: readonly number[]) {
  const at = (offset: number, n: number) => l.slice(offset, offset + n).map((v) => +v.toFixed(4));
  return {
    words: l.length,
    allFinite: l.every(Number.isFinite),
    shL0: [l[LIGHTING.sh + 3], l[LIGHTING.sh + 7], l[LIGHTING.sh + 11]].map((v) => +v.toFixed(4)),
    mainLightPosition: at(LIGHTING.mainLightPosition, 4),
    mainLightColor: at(LIGHTING.mainLightColor, 4),
    ambientSky: at(LIGHTING.ambient, 4),
    reflectionProbe0Hdr: at(LIGHTING.reflectionProbe0, 4),
    lightVolumes: at(LIGHTING.lightVolumes, 8),
    samplePosition: at(LIGHTING.samplePosition, 3),
  };
}
console.log(JSON.stringify(summary, null, 2));
Deno.exit(summary.ok ? 0 : 1);
