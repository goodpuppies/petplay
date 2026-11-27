import { assertAlmostEquals, assertEquals } from "@std/assert";
import * as THREE from "three";
import {
  nativePanelAttachment,
  nativePanelCamera,
  nativeTextureSize,
  stripReadyNativePanels,
} from "./nativeOverlayPanels.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

Deno.test("nativeTextureSize: rounds up in 64px / 128px steps and caps at max", () => {
  assertEquals(nativeTextureSize(10), 64);
  assertEquals(nativeTextureSize(64), 64);
  assertEquals(nativeTextureSize(65), 128);
  assertEquals(nativeTextureSize(2048), 2048);
  assertEquals(nativeTextureSize(2049), 2176);
  assertEquals(nativeTextureSize(9999, 4096), 4096);
});

Deno.test("nativePanelCamera: frames a rotated/scaled root rectangle with overflow margin", () => {
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(0.3, 1.4, -1.2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.4, 0)),
    new THREE.Vector3(0.8, 0.5, 1),
  );
  const cam = nativePanelCamera({
    worldMatrix: new Float32Array(mat.elements),
    pixelWidth: 800,
    pixelHeight: 500,
  });
  assertEquals(cam != null, true);
  assertAlmostEquals(cam!.widthMeters, 0.8 * 1.04, 1e-5);
  assertEquals(cam!.textureWidth % 64, 0);
  assertEquals(cam!.textureHeight % 64, 0);
});

Deno.test("nativePanelAttachment: attaches single-device anchors and skips world/two-hand/frozen", () => {
  const handPose = new THREE.Matrix4().makeTranslation(0.2, 1.1, -0.4);
  const panelPose = new THREE.Matrix4().makeTranslation(0.2, 1.2, -0.4);
  const devices = { "left-hand": { index: 3, pose: handPose.elements } };

  const attached = nativePanelAttachment(
    { space: "left-hand", localMatrix: new Float64Array(16) },
    panelPose.elements,
    devices,
  );
  assertEquals(attached?.index, 3);
  assertAlmostEquals(attached!.relative[13]!, 0.1, 1e-6);

  // Frozen grab must not attach to the moving controller.
  assertEquals(
    nativePanelAttachment(
      { space: "left-hand", follow: true, localMatrix: new Float64Array(16) },
      panelPose.elements,
      devices,
      new Set(["left-hand"]),
    ),
    null,
  );
});

Deno.test("stripReadyNativePanels: only strips confirmed ready surfaces and preserves depth stand-in", () => {
  const bg = { rootIndex: 0, data: new Float32Array(16) } as never;
  const fg = { rootIndex: 1, data: new Float32Array(16) } as never;
  const payload = {
    ui: {
      panels: [bg, fg],
      texts: [{ rootIndex: 0 }, { rootIndex: 1 }],
      images: [],
      surfaces: [
        {
          surfaceId: "ui-ready",
          rootIndex: 0,
          worldMatrix: new Float32Array(16),
          pixelWidth: 400,
          pixelHeight: 300,
          contentRevision: 1,
          depthPanelIndex: 0,
        },
        {
          surfaceId: "ui-pending",
          rootIndex: 1,
          worldMatrix: new Float32Array(16),
          pixelWidth: 400,
          pixelHeight: 300,
          contentRevision: 1,
          depthPanelIndex: 1,
        },
      ],
    },
  } as unknown as WebXRRaythreeRenderPayload;

  const stripped = stripReadyNativePanels(payload, new Set(["ui-ready"]));
  assertEquals(stripped.ui.panels.length, 1);
  assertEquals(stripped.ui.panels[0], fg);
  assertEquals(stripped.ui.texts.length, 1);
  assertEquals(stripped.ui.depthOnlyPanels?.length, 1);
  assertEquals(stripped.ui.depthOnlyPanels?.[0], bg);
});
