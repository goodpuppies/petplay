import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import { fingerprintScene } from "./overlaySceneFingerprint.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

function payload(): WebXRRaythreeRenderPayload {
  const matrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const eye = {
    assets: { geometries: [], materials: [], textures: [] },
    frame: {
      camera: { worldMatrix: matrix(), position: [0, 0, 0] },
      lights: [{ id: 1, type: "ambient", color: [1, 1, 1], intensity: 1 }],
      instances: [
        { nodeId: 1, worldMatrix: new Float64Array(matrix()), renderAnchor: undefined },
        {
          nodeId: 2,
          worldMatrix: new Float64Array(matrix()),
          normalMatrix: new Float64Array(9),
          renderAnchor: { space: "right-hand", localMatrix: matrix() },
        },
      ],
    },
    warnings: [],
  };
  return {
    frame: {
      frameCount: 1,
      eyeWidth: 100,
      eyeHeight: 100,
      outputWidth: 200,
      outputHeight: 100,
      lookRotation: matrix(),
      viewerPosition: new Float32Array(3),
      leftEyeViewMatrix: matrix(),
      leftEyeProjectionMatrix: matrix(),
      rightEyeViewMatrix: matrix(),
      rightEyeProjectionMatrix: matrix(),
      halfFovInRadians: 1,
      ipdMeters: 0.063,
    },
    background: [0, 0, 0, 0],
    leftEye: eye,
    rightEye: eye,
    ui: {
      panels: [{
        worldMatrix: matrix(),
        clipping: matrix(),
        data: new Float32Array(16),
        renderAnchor: { space: "left-hand", localMatrix: matrix() },
      }],
      texts: [{ worldMatrix: matrix(), text: "12:00", geometry: { id: 4, revision: 1 } }],
      images: [],
    },
  } as unknown as WebXRRaythreeRenderPayload;
}

Deno.test("renderer-owned state does not change the fingerprint", () => {
  const a = payload(), b = payload();
  b.frame.frameCount = 99;
  b.frame.leftEyeViewMatrix[12] = 5;
  b.frame.lookRotation[1] = 0.5;
  (b.leftEye.frame.camera as { worldMatrix: Float32Array }).worldMatrix[12] = 3;
  b.leftEye.frame.instances[1]!.worldMatrix[12] = 7;
  b.ui.panels[0]!.worldMatrix[13] = 2;
  b.ui.panels[0]!.clipping[3] = 9;
  assertEquals(fingerprintScene(a), fingerprintScene(b));
});

Deno.test("Glyph tuning alone invalidates scene content", () => {
  const p = payload();
  p.ui.textRendering = {renderer:"glyph", panoramaFilter:"linear", glyphCoverageExponent:1, glyphWeightPixels:0};
  const base = fingerprintScene(p);
  p.ui.textRendering.glyphCoverageExponent = 0.85;
  assertNotEquals(fingerprintScene(p), base);
  p.ui.textRendering.glyphCoverageExponent = 1;
  p.ui.textRendering.glyphWeightPixels = 0.125;
  assertNotEquals(fingerprintScene(p), base);
  p.ui.textRendering.glyphWeightPixels = 0;
  p.ui.textRendering.glyphAaWidth = 0.85;
  assertNotEquals(fingerprintScene(p), base);
  p.ui.textRendering.glyphAaWidth = undefined;
  const glyph = fingerprintScene(p);
  p.ui.textRendering.renderer = "windfoil";
  assertNotEquals(fingerprintScene(p), glyph);
});

Deno.test("scene content changes the fingerprint", () => {
  const base = fingerprintScene(payload());
  const cases: ((p: WebXRRaythreeRenderPayload) => void)[] = [
    (p) => p.leftEye.frame.instances[0]!.worldMatrix[12] = 1, // unanchored motion
    (p) => p.ui.panels[0]!.renderAnchor!.localMatrix[12] = 1,
    (p) => p.ui.panels[0]!.data[3] = 1,
    (p) => p.ui.texts[0]!.text = "12:01",
    (p) => (p.ui.texts[0]!.geometry as { revision: number }).revision = 2,
    (p) => p.ui.texts.pop(),
    (p) => p.frame.leftEyeProjectionMatrix[0] = 0.7,
    (p) => p.background[3] = 1,
    (p) => p.ui.textRendering = { renderer: "pathfinder", panoramaFilter: "catmull-rom" },
    (p) => p.ui.textRendering = { renderer: "glyph", panoramaFilter: "linear", glyphCoverageExponent: 0.85 },
    (p) => p.ui.textRendering = { renderer: "glyph", panoramaFilter: "linear", glyphWeightPixels: 0.125 },
  ];
  for (const mutate of cases) {
    const p = payload();
    mutate(p);
    assertNotEquals(fingerprintScene(p), base, mutate.toString());
  }
  assertNotEquals(fingerprintScene(payload(), 1), base);
});
