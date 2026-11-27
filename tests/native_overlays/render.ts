/**
 * Offscreen check of native overlay rendering through the production renderer; no SteamVR.
 *
 *   deno run -A --no-check tests/native_overlays/render.ts
 *
 * Draws the test scene's panel into its own texture, its cube into a side-by-side stereo texture,
 * and its laser beam and cursor dot into theirs, then reads them back. It checks what SteamVR
 * will be handed: the panel fills its texture upright and unmirrored, native content is gone from
 * the eye image, the two eyes of the stereo texture disagree the way depth requires, the beam is
 * a band across its texture and the dot a disc in its own. PNGs for a look by eye land in
 * `_scratch/native-overlays/`.
 */
import * as THREE from "three";
import { PNG } from "pngjs";
import { WebXROverlayRaylib } from "../../classes/webxrOverlayRaylib.ts";
import {
  nativeMeshQuad,
  nativePanelCamera,
  nativePanelContentHash,
  nativeStereoBoxQuad,
  nativeStereoQuad,
  planNativeContent,
} from "../../classes/nativeOverlayMath.ts";
import {
  BACKGROUND,
  BOX,
  createTestScene,
  CUBE_AHEAD,
  EYE,
  IPD,
  LOWER_RIGHT,
  UPPER_LEFT,
} from "./scene.ts";

const { payload, frame, headPosition, leftEyePosition, rightEyePosition, cubeCenter, panelWorld } =
  createTestScene();

// ---- helpers ----

type Picture = { width: number; height: number; data: Uint8Array };
/** Pixel at texture coordinates (u right, v up): GL storage has row zero at the bottom. */
function at(picture: Picture, u: number, v: number): number[] {
  const x = Math.min(picture.width - 1, Math.floor(u * picture.width));
  const y = Math.min(picture.height - 1, Math.floor(v * picture.height));
  const i = (y * picture.width + x) * 4;
  return Array.from(picture.data.subarray(i, i + 4));
}
/** The panel shader's output encoding is its own business: compare by which channel leads. */
function expectColor(picture: Picture, u: number, v: number, color: number[], what: string) {
  const got = at(picture, u, v);
  const lead = (c: number[]) => c.indexOf(Math.max(c[0]!, c[1]!, c[2]!));
  if (got[3] !== 255 || lead(got) !== lead(color)) {
    throw new Error(`${what}: expected opaque ${color} at (${u}, ${v}), got ${got}`);
  }
}
/** Counts and mean column of pixels `match` accepts inside columns `from`..`to`. */
function find(picture: Picture, from: number, to: number, match: (p: number[]) => boolean) {
  let count = 0, sumX = 0;
  for (let y = 0; y < picture.height; y++) {
    for (let x = from; x < to; x++) {
      const i = (y * picture.width + x) * 4;
      if (
        match([picture.data[i]!, picture.data[i + 1]!, picture.data[i + 2]!, picture.data[i + 3]!])
      ) {
        count++;
        sumX += x - from;
      }
    }
  }
  return { count, meanX: count ? sumX / count : NaN };
}
function save(picture: Picture, name: string): string {
  const png = new PNG({ width: picture.width, height: picture.height });
  // PNG rows run top to bottom.
  for (let y = 0; y < picture.height; y++) {
    const from = (picture.height - 1 - y) * picture.width * 4;
    png.data.set(picture.data.subarray(from, from + picture.width * 4), y * picture.width * 4);
  }
  Deno.mkdirSync(`${Deno.cwd()}/_scratch/native-overlays`, { recursive: true });
  const path = `${Deno.cwd()}/_scratch/native-overlays/${name}.png`;
  Deno.writeFileSync(path, PNG.sync.write(png));
  return path;
}
const isMagenta = (p: number[]) => p[0]! > 180 && p[1]! < 80 && p[2]! > 180 && p[3]! > 200;

// ---- render ----

const compositor = new WebXROverlayRaylib(EYE);
compositor.initialize("PetPlay native overlays (offscreen)");
let completed = false;
try {
  // Baseline: without a plan everything is in the eye image.
  compositor.renderRaythreeFrame(payload, { skipCombine: true });
  const baseline = compositor.readRenderTargetRgba("left");
  save(baseline, "eye-baseline");
  const baselineCube = find(baseline, 0, EYE, isMagenta).count;
  const baselineUi = find(baseline, 0, EYE, (p) => p[3]! > 200).count;
  if (baselineCube < 20) throw new Error(`Baseline eye has no cube (${baselineCube} px)`);
  if (baselineUi < 2000) throw new Error(`Baseline eye has no panel (${baselineUi} px)`);

  const plan = planNativeContent(payload, { panels: true, stereo: true });
  if (!plan || plan.panels.length !== 1 || plan.stereo.length !== 2 || plan.quads.length !== 2) {
    throw new Error("Native content was not planned");
  }
  frame.frameCount++;
  compositor.renderRaythreeFrame(plan.eyePayload, { skipCombine: true });
  const eye = compositor.readRenderTargetRgba("left");
  save(eye, "eye-native");
  const left = find(eye, 0, EYE, (p) => p[3]! > 8).count;
  if (left !== 0) throw new Error(`${left} pixels of native content are still in the eye image`);
  console.log(`PASS: eye image had ${baselineUi} panel px and ${baselineCube} cube px, now none`);

  // Panel.
  const item = plan.panels[0]!;
  const panelCamera = nativePanelCamera(item.panel)!;
  if (panelCamera.textureWidth !== 1600 || panelCamera.textureHeight !== 1024) {
    throw new Error(`Panel texture ${panelCamera.textureWidth}x${panelCamera.textureHeight}`);
  }
  const hash = nativePanelContentHash(item, panelCamera);
  const texture = compositor.renderNativePanel("panel.test", item.ui, panelCamera);
  if (!(texture > 0)) throw new Error("No panel texture");
  const panel = compositor.readNativeTargetRgba("panel.test");
  const panelPath = save(panel, "panel");
  if (panel.width !== 1600 || panel.height !== 1024) throw new Error("Panel readback size");
  expectColor(panel, 0.5, 0.25, BACKGROUND, "panel background");
  // Marker 0.3 m left of and 0.17 m above the centre: low u, high v. Upright and unmirrored.
  expectColor(panel, 0.125, 0.84, UPPER_LEFT, "upper-left marker");
  expectColor(panel, 0.875, 0.16, LOWER_RIGHT, "lower-right marker");
  // The background reaches every edge of the texture, and its rounded corners stay clear.
  for (const [u, v] of [[0.004, 0.5], [0.996, 0.5], [0.5, 0.006], [0.5, 0.994]]) {
    expectColor(panel, u!, v!, BACKGROUND, "panel edge");
  }
  for (const [u, v] of [[0.002, 0.003], [0.998, 0.003], [0.002, 0.997], [0.998, 0.997]]) {
    if (at(panel, u!, v!)[3]! > 8) throw new Error(`Corner (${u}, ${v}) is not transparent`);
  }
  // Text: white glyphs right of the label's start, in the row band the label sits in.
  const white = (p: number[]) => p[0]! > 200 && p[1]! > 200 && p[2]! > 200;
  const glyphs = find(panel, 0, panel.width, white);
  if (glyphs.count < 400) throw new Error(`Text missing from the panel (${glyphs.count} px)`);
  // The label starts 0.3 m left of the centre and ends short of the right edge.
  const startsLeft = find(panel, 0, Math.round(panel.width * 0.12), white).count;
  if (startsLeft !== 0) throw new Error("Text reaches left of where its label starts: mirrored?");
  const start = find(panel, Math.round(panel.width * 0.13), Math.round(panel.width * 0.3), white);
  if (start.count < 50) throw new Error("Text does not start where its label does: mirrored?");
  console.log(`PASS: panel texture 1600x1024 upright, ${glyphs.count} glyph px; ${panelPath}`);

  // The same picture again is the same pixels; a moved panel keeps its hash.
  compositor.renderNativePanel("panel.test", item.ui, panelCamera);
  const again = compositor.readNativeTargetRgba("panel.test");
  for (let i = 0; i < panel.data.length; i++) {
    if (panel.data[i] !== again.data[i]) throw new Error("Second buffer differs from the first");
  }
  if (nativePanelContentHash(item, panelCamera) !== hash) throw new Error("Hash is not stable");

  // Stereo cube.
  const group = plan.stereo.find((candidate) => candidate.key === "cube")!;
  const quad = nativeStereoQuad(
    group.center,
    group.radius,
    headPosition.toArray(),
    leftEyePosition.toArray(),
    rightEyePosition.toArray(),
  )!;
  const size = 512;
  compositor.renderNativeStereo(
    "stereo.cube",
    plan.eyePayload.leftEye,
    group.instances,
    quad,
    size,
  );
  const stereo = compositor.readNativeTargetRgba("stereo.cube");
  const stereoPath = save(stereo, "stereo");
  if (stereo.width !== size * 2 || stereo.height !== size) throw new Error("Stereo readback size");
  const leftEye = find(stereo, 0, size, isMagenta);
  const rightEye = find(stereo, size, size * 2, isMagenta);
  if (leftEye.count < 50 || rightEye.count < 50) {
    throw new Error(`Cube missing from an eye: left ${leftEye.count}, right ${rightEye.count}`);
  }
  // The lit cube is teal in both eyes, not black: the pass applies the scene's lights.
  const isTeal = (p: number[]) => p[1]! > 90 && p[2]! > 90 && p[0]! < p[1]! * 0.7 && p[3]! > 200;
  const litLeft = find(stereo, 0, size, isTeal).count;
  const litRight = find(stereo, size, size * 2, isTeal).count;
  if (litLeft < 100 || litRight < 100) {
    throw new Error(`Lit cube is not lit: ${litLeft} / ${litRight} teal px`);
  }
  // In front of the quad's plane: the left eye sees it further right than the right eye does.
  const disparity = leftEye.meanX - rightEye.meanX;
  // A point `ahead` metres in front of a plane `planeDistance` away shifts between the eyes by
  // ipd * ahead / (planeDistance - ahead) on that plane; the quad spans `quad.size` m over the eye.
  const normal = new THREE.Vector3().setFromMatrixColumn(
    new THREE.Matrix4().fromArray(quad.pose),
    2,
  );
  const planeDistance = headPosition.distanceTo(cubeCenter);
  const ahead = new THREE.Vector3(0, 0, CUBE_AHEAD).dot(normal);
  const across = new THREE.Vector3().setFromMatrixColumn(
    new THREE.Matrix4().fromArray(quad.pose),
    0,
  );
  const ipdAcross = Math.abs(new THREE.Vector3(IPD, 0, 0).dot(across));
  const expected = ipdAcross * ahead / (planeDistance - ahead) / quad.width * size;
  if (!(disparity > expected * 0.7 && disparity < expected * 1.3)) {
    throw new Error(
      `Stereo disparity ${disparity.toFixed(2)} px, expected ~${expected.toFixed(2)}`,
    );
  }
  console.log(
    `PASS: stereo texture ${stereo.width}x${stereo.height}, disparity ${disparity.toFixed(2)} px ` +
      `(expected ~${expected.toFixed(2)}); ${stereoPath}`,
  );
  // The grab box's outline, on a quad in its nearer face, seen from a little to the side.
  const outline = plan.stereo.find((candidate) => candidate.key === "box")!;
  const rotation = new THREE.Matrix4().extractRotation(panelWorld);
  const boxCenter = new THREE.Vector3().setFromMatrixPosition(panelWorld);
  const from = (x: number) =>
    new THREE.Vector3(0.22 + x, 0.1, 1.1).applyMatrix4(rotation).add(boxCenter).toArray();
  const boxQuad = nativeStereoBoxQuad(
    outline.instances,
    BOX,
    from(0),
    from(-IPD / 2),
    from(IPD / 2),
  );
  if (!boxQuad?.redrawAfter) throw new Error("The box outline did not get a quad in its face");
  const boxEyeWidth = Math.round(boxQuad.width * 1500);
  const boxEyeHeight = Math.round(boxEyeWidth * boxQuad.height / boxQuad.width);
  const isBar = (p: number[]) => p[2]! > 150 && p[2]! > p[0]! + 60 && p[3]! > 200;
  const drawBox = (name: string, depthPanels?: typeof payload.ui.panels) => {
    compositor.renderNativeStereo(
      "stereo.box",
      plan.eyePayload.leftEye,
      outline.instances,
      boxQuad,
      boxEyeWidth,
      boxEyeHeight,
      depthPanels,
    );
    const picture = compositor.readNativeTargetRgba("stereo.box");
    if (picture.width !== boxEyeWidth * 2 || picture.height !== boxEyeHeight) {
      throw new Error(`Box readback ${picture.width}x${picture.height}`);
    }
    return {
      path: save(picture, name),
      left: find(picture, 0, boxEyeWidth, isBar).count,
      right: find(picture, boxEyeWidth, boxEyeWidth * 2, isBar).count,
      other: find(picture, 0, picture.width, (p) => p[3]! > 8 && !isBar(p)).count,
    };
  };
  const wire = drawBox("box-wireframe");
  const framed = drawBox("box", plan.eyePayload.ui.depthOnlyPanels);
  if (wire.left < 2000 || wire.right < 2000) {
    throw new Error(`Box bars missing: ${wire.left} / ${wire.right} px`);
  }
  // Behind the panel's background the far bars are hidden, as they are in the eye image; the
  // panel itself is not drawn here.
  if (!(framed.left < wire.left * 0.95 && framed.left > wire.left * 0.4)) {
    throw new Error(`Far bars not hidden behind the panel: ${framed.left} of ${wire.left} px`);
  }
  if (framed.other > framed.left * 0.2) {
    throw new Error(`Something besides the bars was drawn: ${framed.other} px`);
  }
  console.log(
    `PASS: box outline ${boxEyeWidth}x${boxEyeHeight} per eye on a ${boxQuad.width.toFixed(3)} x ` +
      `${boxQuad.height.toFixed(3)} m quad, ${framed.left} bar px (${wire.left} without the ` +
      `panel hiding the far bars), redraw after ${(boxQuad.redrawAfter * 1000).toFixed(1)} mm; ` +
      framed.path,
  );

  // The laser beam: a band across the middle quarter of its texture from end to end, in the
  // beam's colour, the same however the beam is rolled. The dot: a disc in the middle of its own.
  const head = headPosition.toArray();
  const beamPlan = plan.quads.find((quad) => quad.shape === "beam")!;
  const beamQuad = nativeMeshQuad(beamPlan.instance.worldMatrix, "beam", beamPlan.extent, head)!;
  compositor.renderNativeMesh(
    "quad.beam",
    plan.eyePayload.leftEye,
    [beamPlan.instance],
    beamQuad,
    beamQuad.textureWidth,
    beamQuad.textureHeight,
  );
  const beam = compositor.readNativeTargetRgba("quad.beam");
  const beamPath = save(beam, "beam");
  if (beam.width !== beamQuad.textureWidth || beam.height !== 16) {
    throw new Error("Beam readback size");
  }
  const isBeam = (p: number[]) => p[2]! > 200 && p[1]! > 150 && p[0]! < 150 && p[3]! > 250;
  for (const u of [0.001, 0.25, 0.5, 0.75, 0.999]) {
    const rows = [];
    for (let row = 0; row < 16; row++) rows.push(at(beam, u, (row + 0.5) / 16));
    const band = rows.map((p, row) => isBeam(p) ? row : -1).filter((row) => row >= 0);
    const clear = rows.filter((p) => p[3]! === 0).length;
    if (band.join() !== "6,7,8,9" || clear !== 12) {
      throw new Error(`Beam at u=${u}: band rows ${band.join() || "none"}, ${clear} clear rows`);
    }
  }
  const dotPlan = plan.quads.find((quad) => quad.shape === "flat")!;
  const dotQuad = nativeMeshQuad(dotPlan.instance.worldMatrix, "flat", dotPlan.extent, head)!;
  compositor.renderNativeMesh(
    "quad.dot",
    plan.eyePayload.leftEye,
    [dotPlan.instance],
    dotQuad,
    dotQuad.textureWidth,
    dotQuad.textureHeight,
  );
  const dot = compositor.readNativeTargetRgba("quad.dot");
  const dotPath = save(dot, "dot");
  const lit = find(dot, 0, dot.width, (p) => p[3]! > 100 && p[0]! > 200);
  // A disc four fifths as wide as the texture: pi * (0.4 * 64)^2 texels, a little less for its
  // twenty straight sides.
  const disc = Math.PI * (0.4 * dot.width) ** 2;
  if (!(lit.count > disc * 0.93 && lit.count < disc * 1.02)) {
    throw new Error(`Dot covers ${lit.count} texels, expected about ${disc.toFixed(0)}`);
  }
  if (Math.abs(lit.meanX - (dot.width - 1) / 2) > 0.6) {
    throw new Error(`Dot is off centre: ${lit.meanX}`);
  }
  for (const [u, v] of [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.03]]) {
    if (at(dot, u!, v!)[3] !== 0) throw new Error(`Dot texture is not clear at (${u}, ${v})`);
  }
  console.log(
    `PASS: beam ${beam.width}x${beam.height} for a ${beamQuad.width.toFixed(3)} x ` +
      `${(beamQuad.height * 1000).toFixed(0)} mm quad (texel aspect ${
        beamQuad.texelAspect.toFixed(2)
      }), ` +
      `band in rows 6 to 9 from end to end; dot ${dot.width}x${dot.height}, ${lit.count} texels lit; ` +
      `${beamPath}, ${dotPath}`,
  );
  completed = true;
} finally {
  try {
    compositor.cleanup();
  } catch (error) {
    // After a failed check that failure is the one to report; after a pass this one is.
    console.error("Renderer cleanup:", error);
    if (completed) Deno.exitCode = 1;
  }
}
