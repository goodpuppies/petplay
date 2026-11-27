import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from "@std/assert";
import * as THREE from "three";
import {
  nativeMeshQuad,
  nativePanelAttachment,
  nativePanelCamera,
  nativePanelContentHash,
  nativeStereoBoxQuad,
  nativeStereoBoxSphere,
  nativeStereoContentHash,
  nativeStereoQuad,
  nativeTextureSize,
  planNativeContent,
} from "./nativeOverlayMath.ts";
import type { NativePanelSnapshot } from "./nativeOverlayContent.ts";
import { fingerprintScene } from "./overlaySceneFingerprint.ts";
import { OverlaySceneWireDecoder, OverlaySceneWireEncoder } from "./overlaySceneWire.ts";
import { resolveRenderAnchors } from "./overlayRenderTracking.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";

const identity = () => new Float32Array(new THREE.Matrix4().elements);

const WIDTH = 0.8, HEIGHT = 0.5;

/**
 * A root 800 × 500 px (0.8 × 0.5 m), 1 m in front of the origin at eye height, turned a little,
 * scaled by `scale`. Like a uikit root's, its matrix maps the unit square onto its rectangle and
 * its Z column carries no length.
 */
function panelMatrix(scale = 1): Float32Array {
  return new Float32Array(
    new THREE.Matrix4().compose(
      new THREE.Vector3(0.2, 1.5, -1),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)),
      new THREE.Vector3(WIDTH * scale, HEIGHT * scale, 0),
    ).elements,
  );
}

function nativePanel(scale = 1): NativePanelSnapshot {
  return {
    key: "ui-1",
    rootIndices: [1],
    worldMatrix: panelMatrix(scale),
    pixelWidth: 800,
    pixelHeight: 500,
  };
}

/** A UI item `x`, `y` metres (before the panel's scale) from the panel's centre, on its plane. */
function onPanel(panel: NativePanelSnapshot, x: number, y: number): Float32Array {
  return new Float32Array(
    new THREE.Matrix4().fromArray(panel.worldMatrix).multiply(
      new THREE.Matrix4().makeTranslation(x / WIDTH, y / HEIGHT, 0),
    ).elements,
  );
}

const glyphs = (id: number) => ({
  id,
  revision: 1,
  version: 1,
  positions: new Float32Array(8),
  uvs: new Float32Array(8),
  indices: new Uint16Array(6),
});

function payload(panel = nativePanel()): WebXRRaythreeRenderPayload {
  const data = (width: number, height: number, opacity: number) => {
    const d = new Float32Array(16);
    d[7] = opacity;
    d[14] = width;
    d[15] = height;
    return d;
  };
  const uiPanel = (rootIndex: number, worldMatrix: Float32Array, d: Float32Array) => ({
    worldMatrix,
    data: d,
    clipping: new Float32Array(16),
    instanceIndex: 0,
    renderOrder: 0,
    depthTest: true,
    depthWrite: false,
    rootIndex,
  });
  const eye = {
    assets: { geometries: [], materials: [], textures: [] },
    frame: {
      camera: { worldMatrix: identity(), position: [0, 0, 0] },
      lights: [],
      instances: [
        { nodeId: 1, geometryId: 1, materialId: 1, worldMatrix: new Float64Array(identity()) },
        {
          nodeId: 2,
          geometryId: 1,
          materialId: 1,
          worldMatrix: new Float64Array(identity()),
          nativeStereo: { key: "cube", radius: 0.2, center: [0, 1, -1] },
        },
      ],
    },
    warnings: [],
  };
  return {
    delivery: { epoch: "e", stream: "s", sequence: 1 },
    frame: {
      frameCount: 1,
      eyeWidth: 100,
      eyeHeight: 100,
      outputWidth: 200,
      outputHeight: 100,
      lookRotation: identity(),
      viewerPosition: new Float32Array(3),
      leftEyeViewMatrix: identity(),
      leftEyeProjectionMatrix: identity(),
      rightEyeViewMatrix: identity(),
      rightEyeProjectionMatrix: identity(),
      halfFovInRadians: 1,
      ipdMeters: 0.063,
    },
    background: [0, 0, 0, 0],
    leftEye: eye,
    rightEye: eye,
    ui: {
      panels: [
        uiPanel(0, identity(), data(100, 100, 1)),
        // The settings root: a see-through wrapper, its background and a button.
        uiPanel(1, onPanel(panel, 0, 0), data(800, 500, 0)),
        uiPanel(1, onPanel(panel, 0, 0), data(800, 500, 1)),
        uiPanel(1, onPanel(panel, 0.1, 0.1), data(80, 40, 1)),
      ],
      texts: [
        {
          worldMatrix: identity(),
          text: "wrist",
          color: [1, 1, 1, 1],
          fontSize: 12,
          rootIndex: 0,
          geometry: glyphs(1),
        },
        {
          worldMatrix: onPanel(panel, -0.1, 0),
          text: "General",
          color: [1, 1, 1, 1],
          fontSize: 20,
          rootIndex: 1,
          geometry: glyphs(2),
        },
      ],
      images: [],
      nativePanels: [panel],
    },
  } as unknown as WebXRRaythreeRenderPayload;
}

Deno.test("nothing native leaves the scene untouched", () => {
  const scene = payload();
  delete scene.ui.nativePanels;
  assertEquals(planNativeContent(scene, { panels: true, stereo: false }), null);
  // Marked panels are ordinary UI until a renderer is told to use them.
  assertEquals(planNativeContent(payload(), { panels: false, stereo: false }), null);
});

Deno.test("a native panel's items leave the eye image and its background stays as depth", () => {
  const scene = payload();
  const plan = planNativeContent(scene, { panels: true, stereo: false })!;
  assertEquals(plan.eyePayload.ui.panels.map((p) => p.rootIndex), [0]);
  assertEquals(plan.eyePayload.ui.texts.map((t) => t.text), ["wrist"]);
  assertEquals(plan.panels.length, 1);
  assertEquals(plan.panels[0]!.ui.panels.length, 3);
  assertEquals(plan.panels[0]!.ui.texts.map((t) => t.text), ["General"]);
  // The opaque 800 × 500 background, not the transparent wrapper of the same size.
  assertEquals(plan.eyePayload.ui.depthOnlyPanels, [scene.ui.panels[2]!]);
  // The scene itself is not modified: other views still draw everything.
  assertEquals(scene.ui.panels.length, 4);
  assertEquals(plan.eyePayload.leftEye, scene.leftEye);
});

Deno.test("stereo groups leave both eyes, which stay one object", () => {
  const scene = payload();
  const plan = planNativeContent(scene, { panels: false, stereo: true })!;
  assertEquals(plan.panels.length, 0);
  assertEquals(plan.eyePayload.ui, scene.ui);
  assertEquals(plan.eyePayload.leftEye.frame.instances.length, 1);
  assert(plan.eyePayload.rightEye === plan.eyePayload.leftEye);
  assertEquals(plan.stereo.length, 1);
  assertEquals(plan.stereo[0]!.key, "cube");
  assertEquals(plan.stereo[0]!.center, [0, 1, -1]);
  assertEquals(plan.stereo[0]!.instances.length, 1);
  assertEquals(scene.leftEye.frame.instances.length, 2);
});

Deno.test("the pointer's meshes leave the eyes with the panels, and only with them", () => {
  const scene = payload();
  const mark = (key: string, shape: "beam" | "flat") => ({
    nodeId: 9,
    kind: "mesh",
    geometryId: 2,
    materialId: 2,
    worldMatrix: new Float64Array(identity()),
    nativeQuad: { key, shape, extent: [0.5, 0.5, 0.5] },
  });
  const instances = scene.leftEye.frame.instances as unknown[];
  instances.push(mark("laser-1", "beam"), mark("cursor-1", "flat"), mark("laser-1", "beam"));
  const native = planNativeContent(scene, { panels: true, stereo: true })!;
  // One quad per name; the repeated one is dropped, not drawn twice.
  assertEquals(native.quads.map((quad) => [quad.key, quad.shape]), [["laser-1", "beam"], [
    "cursor-1",
    "flat",
  ]]);
  assert(native.quads[0]!.instance === instances[2]);
  assertEquals(native.eyePayload.leftEye.frame.instances.length, 1);
  assert(native.eyePayload.rightEye === native.eyePayload.leftEye);
  // In the other present modes the UI is in the eye image, and the pointer stays with it.
  const other = planNativeContent(scene, { panels: false, stereo: true })!;
  assertEquals(other.quads.length, 0);
  assertEquals(other.eyePayload.leftEye.frame.instances.length, 4);
  // A scene with nothing else native still hands them over.
  delete scene.ui.nativePanels;
  assertEquals(planNativeContent(scene, { panels: true, stereo: false })!.quads.length, 2);
});

Deno.test("the panel camera maps the panel's rectangle onto the whole texture", () => {
  const panel = nativePanel(1.5);
  const camera = nativePanelCamera(panel)!;
  // Two texels per pixel of its 800 x 500, rounded up to the next step.
  assertEquals([camera.textureWidth, camera.textureHeight], [1600, 1024]);
  assertAlmostEquals(camera.widthMeters, 1.2, 1e-6);
  // The texels are a little wider than tall, and SteamVR is told: the quad keeps the panel's shape.
  assertAlmostEquals(camera.texelAspect, 1.024, 1e-6);
  assertAlmostEquals(
    camera.widthMeters * (camera.textureHeight / camera.textureWidth) / camera.texelAspect,
    HEIGHT * 1.5,
    1e-6,
  );
  // A corner of the root's rectangle, `ahead` metres in front of its plane.
  const normal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, 0.4, 0));
  const project = (x: number, y: number, ahead = 0) =>
    new THREE.Vector3(x, y, 0)
      .applyMatrix4(new THREE.Matrix4().fromArray(panel.worldMatrix))
      .addScaledVector(normal, ahead)
      .applyMatrix4(new THREE.Matrix4().fromArray(camera.viewMatrix))
      .applyMatrix4(new THREE.Matrix4().fromArray(camera.projectionMatrix));
  const corner = project(0.5, 0.5);
  assertAlmostEquals(corner.x, 1, 1e-5);
  assertAlmostEquals(corner.y, 1, 1e-5);
  const lowerLeft = project(-0.5, -0.5);
  assertAlmostEquals(lowerLeft.x, -1, 1e-5);
  assertAlmostEquals(lowerLeft.y, -1, 1e-5);
  // On the plane, and a hand's width in front of it, are both inside the depth range.
  assert(Math.abs(corner.z) < 0.5);
  const raised = project(0.5, 0.5, 0.1);
  assertAlmostEquals(raised.x, 1, 1e-5);
  assert(Math.abs(raised.z) < 0.5 && raised.z !== corner.z);
  // SteamVR gets the centre without the size: unit axes, same position.
  const pose = new THREE.Matrix4().fromArray(camera.pose);
  assertAlmostEquals(pose.determinant(), 1, 1e-5);
  assertAlmostEquals(pose.elements[12]!, 0.2, 1e-6);
  assertAlmostEquals(pose.elements[13]!, 1.5, 1e-6);
  assertAlmostEquals(pose.elements[14]!, -1, 1e-6);
  assertAlmostEquals(new THREE.Vector3().setFromMatrixColumn(pose, 2).dot(normal), 1, 1e-6);
});

Deno.test("a laser beam gets a quad along itself that faces the head", () => {
  const from = new THREE.Vector3(0.2, 1.2, -0.1), to = new THREE.Vector3(0.3, 1.5, -1.3);
  const length = from.distanceTo(to);
  const beam = new THREE.Object3D();
  beam.position.copy(from).lerp(to, 0.5);
  beam.lookAt(to);
  // Rolled about its own axis, as a controller holds it: that must not show.
  beam.rotateZ(0.7);
  beam.scale.set(0.002, 0.002, length);
  beam.updateMatrixWorld(true);
  const head = new THREE.Vector3(0, 1.6, 0);
  const quad = nativeMeshQuad(beam.matrixWorld.elements, "beam", [0.5, 0.5, 0.5], head.toArray())!;
  assertAlmostEquals(quad.width, length, 1e-9);
  assertAlmostEquals(quad.height, 0.008, 1e-9);
  const pose = new THREE.Matrix4().fromArray(quad.pose);
  assertAlmostEquals(pose.determinant(), 1, 1e-5);
  const along = to.clone().sub(from).normalize();
  const x = new THREE.Vector3().setFromMatrixColumn(pose, 0);
  const z = new THREE.Vector3().setFromMatrixColumn(pose, 2);
  const centre = new THREE.Vector3().setFromMatrixPosition(pose);
  assertAlmostEquals(Math.abs(x.dot(along)), 1, 1e-6);
  assertAlmostEquals(centre.distanceTo(beam.position), 0, 1e-6);
  // Square on to the head, as far as a quad that holds the beam can be: the head lies in the
  // plane spanned by the beam and the quad's normal, on the normal's side.
  const toHead = head.clone().sub(centre);
  assertAlmostEquals(toHead.dot(new THREE.Vector3().setFromMatrixColumn(pose, 1)), 0, 1e-6);
  assert(toHead.dot(z) > 0);

  // The picture: the beam from end to end, a band across the middle quarter of the texture,
  // whatever the roll. Every corner of the box lands on the band's outline.
  const picture = new THREE.Matrix4().fromArray(quad.projectionMatrix)
    .multiply(new THREE.Matrix4().fromArray(quad.viewMatrix)).multiply(beam.matrixWorld);
  for (const sx of [-0.5, 0.5]) {
    for (const sy of [-0.5, 0.5]) {
      for (const sz of [-0.5, 0.5]) {
        const corner = new THREE.Vector3(sx, sy, sz).applyMatrix4(picture);
        assertAlmostEquals(Math.abs(corner.x), 1, 1e-5);
        assertAlmostEquals(Math.abs(corner.y), 0.25, 1e-5);
        assert(Math.abs(corner.z) < 1);
      }
    }
  }
  // The texels stay within a factor of two of square, and SteamVR is told the rest.
  assertEquals([quad.textureWidth, quad.textureHeight], [4096, 16]);
  assert(quad.texelAspect > 0.5 && quad.texelAspect < 2);
  assertAlmostEquals(quad.width * (16 / 4096) / quad.texelAspect, quad.height, 1e-9);
});

Deno.test("a beam keeps its texture while its length hovers at a boundary", () => {
  const quadOf = (length: number, keep?: number) => {
    const beam = new THREE.Matrix4().makeScale(0.002, 0.002, length);
    return nativeMeshQuad(beam.elements, "beam", [0.5, 0.5, 0.5], [0, 1, 0], keep)!;
  };
  // Square texels would be 2048 across at 1.024 m: the boundary between two textures.
  assertEquals(quadOf(1.0).textureWidth, 1024);
  assertEquals(quadOf(1.05).textureWidth, 4096);
  assertEquals(quadOf(1.05, 1024).textureWidth, 1024);
  assertEquals(quadOf(1.0, 4096).textureWidth, 4096);
  // Far enough and the kept one goes.
  assertEquals(quadOf(1.4, 1024).textureWidth, 4096);
  assertEquals(quadOf(0.7, 4096).textureWidth, 1024);
  for (const length of [0.05, 0.2, 0.6, 1.0, 1.5, 2.5]) {
    const quad = quadOf(length);
    assert(
      quad.texelAspect >= 0.5 - 1e-9 && quad.texelAspect <= 2 + 1e-9,
      `${length} m: ${quad.texelAspect}`,
    );
  }
  // No head to face (it lies on the beam's axis) still gives a quad; no size gives none.
  assert(
    nativeMeshQuad(
      new THREE.Matrix4().makeScale(0.002, 0.002, 1).elements,
      "beam",
      [0.5, 0.5, 0.5],
      [0, 0, 3],
    ),
  );
  assertEquals(
    nativeMeshQuad(
      new THREE.Matrix4().makeScale(0.002, 0.002, 0).elements,
      "beam",
      [0.5, 0.5, 0.5],
      [0, 1, 0],
    ),
    null,
  );
});

Deno.test("a cursor dot gets a quad in its own plane", () => {
  const dot = new THREE.Object3D();
  dot.position.set(0.3, 1.4, -1.2);
  dot.lookAt(0, 1.2, 0);
  dot.scale.setScalar(0.006);
  dot.updateMatrixWorld(true);
  const quad = nativeMeshQuad(dot.matrixWorld.elements, "flat", [1, 1, 0], [0, 1.6, 0])!;
  assertAlmostEquals(quad.width, 0.015, 1e-9);
  assertAlmostEquals(quad.height, 0.015, 1e-9);
  assertAlmostEquals(quad.texelAspect, 1, 1e-9);
  assertEquals([quad.textureWidth, quad.textureHeight], [64, 64]);
  const pose = new THREE.Matrix4().fromArray(quad.pose);
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(dot.matrixWorld);
  assertAlmostEquals(new THREE.Vector3().setFromMatrixColumn(pose, 2).dot(facing), 1, 1e-6);
  // Its rim reaches four fifths of the way to the texture's edge.
  const picture = new THREE.Matrix4().fromArray(quad.projectionMatrix)
    .multiply(new THREE.Matrix4().fromArray(quad.viewMatrix)).multiply(dot.matrixWorld);
  const rim = new THREE.Vector3(1, 0, 0).applyMatrix4(picture);
  assertAlmostEquals(rim.x, 0.8, 1e-5);
  assertAlmostEquals(rim.y, 0, 1e-5);
});

Deno.test("texture sizes come in steps, rounded up", () => {
  assertEquals(nativeTextureSize(1), 64);
  assertEquals(nativeTextureSize(64), 64);
  assertEquals(nativeTextureSize(65), 128);
  assertEquals(nativeTextureSize(1000), 1024);
  assertEquals(nativeTextureSize(1024), 1024);
  assertEquals(nativeTextureSize(1025), 1088);
  assertEquals(nativeTextureSize(2049), 2176);
  assertEquals(nativeTextureSize(1600), 1600);
  assertEquals(nativeTextureSize(5000), 4096);
  assertEquals(nativeTextureSize(3000, 2048), 2048);
  // A panel growing from 400 to 500 pixels passes through four sizes, not a hundred.
  const sizes = new Set<number>();
  for (let pixels = 400; pixels <= 500; pixels++) sizes.add(nativeTextureSize(pixels * 2));
  assertEquals([...sizes], [832, 896, 960, 1024]);
});

Deno.test("a large panel's texture is capped with its shape kept", () => {
  const camera = nativePanelCamera(
    { ...nativePanel(), pixelWidth: 4000, pixelHeight: 1000 },
    2,
    4096,
  )!;
  assertEquals([camera.textureWidth, camera.textureHeight], [4096, 1024]);
  assertEquals(nativePanelCamera({ ...nativePanel(), worldMatrix: new Float32Array(16) }), null);
  assertEquals(nativePanelCamera({ ...nativePanel(), pixelWidth: 0 }), null);
});

Deno.test("a panel stretched along one axis tells SteamVR its texels are not square", () => {
  const stretched = nativePanel();
  // Twice as tall in the room as its 800 x 500 pixels say.
  stretched.worldMatrix = new Float32Array(
    new THREE.Matrix4().makeScale(WIDTH, HEIGHT * 2, 0).elements,
  );
  const camera = nativePanelCamera(stretched)!;
  // SteamVR makes the quad width * (texture height / width) / aspect tall: 1.0 m, as the panel is.
  assertAlmostEquals(
    camera.widthMeters * (camera.textureHeight / camera.textureWidth) / camera.texelAspect,
    HEIGHT * 2,
    1e-6,
  );
});

Deno.test("moving a panel keeps its picture, changing its content does not", () => {
  const plan = (scene: WebXRRaythreeRenderPayload) => {
    const item = planNativeContent(scene, { panels: true, stereo: false })!.panels[0]!;
    return nativePanelContentHash(item, nativePanelCamera(item.panel)!);
  };
  const base = plan(payload());
  // Carried elsewhere: the plane and every item on it move together.
  const moved = nativePanel();
  moved.worldMatrix = new Float32Array(
    new THREE.Matrix4().compose(
      new THREE.Vector3(-1.3, 0.9, 0.4),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -2, 0.1)),
      new THREE.Vector3(WIDTH, HEIGHT, 0),
    ).elements,
  );
  assertEquals(plan(payload(moved)), base);

  const hovered = payload();
  hovered.ui.panels[3]!.data[4] = 0.5;
  assertNotEquals(plan(hovered), base);
  const retitled = payload();
  retitled.ui.texts[1]!.text = "Debug";
  assertNotEquals(plan(retitled), base);
  const scrolled = payload();
  scrolled.ui.panels[3]!.worldMatrix[13]! += 0.01;
  assertNotEquals(plan(scrolled), base);
});

Deno.test("a panel riding a hand keeps its picture through tracking noise", () => {
  const plan = (scene: WebXRRaythreeRenderPayload) => {
    const item = planNativeContent(scene, { panels: true, stereo: false })!.panels[0]!;
    return nativePanelContentHash(item, nativePanelCamera(item.panel)!);
  };
  // A wrist menu: the root and everything on it are placed in the hand's space. Each frame the
  // renderer rebuilds their world matrices from a fresh hand pose, in 32-bit floats.
  const onHand = (hand: THREE.Matrix4) => {
    const scene = payload();
    const anchor = (item: { worldMatrix: Float32Array; renderAnchor?: unknown }, root = false) => {
      const local = new THREE.Matrix4().fromArray(item.worldMatrix);
      item.renderAnchor = { space: "right-hand", localMatrix: new Float64Array(local.elements) };
      item.worldMatrix.set(hand.clone().multiply(local).elements);
      return root;
    };
    anchor(scene.ui.nativePanels![0]!, true);
    for (const item of scene.ui.panels) if (item.rootIndex === 1) anchor(item);
    for (const item of scene.ui.texts) if (item.rootIndex === 1) anchor(item);
    return scene;
  };
  const pose = (x: number, turn: number) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, 1.1, -0.3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, turn, -0.2)),
      new THREE.Vector3(1, 1, 1),
    );
  const base = plan(onHand(pose(0.2, 0.5)));
  for (let i = 1; i <= 50; i++) {
    assertEquals(plan(onHand(pose(0.2 + i * 0.0137, 0.5 + i * 0.0711))), base, `hand pose ${i}`);
  }
  // What is drawn on it still counts.
  const pressed = onHand(pose(0.2, 0.5));
  pressed.ui.panels[3]!.data[4] = 0.5;
  assertNotEquals(plan(pressed), base);
  const slid = onHand(pose(0.2, 0.5));
  (slid.ui.panels[3]!.renderAnchor!.localMatrix as Float64Array)[12]! += 0.01;
  assertNotEquals(plan(slid), base);
});

Deno.test("a panel on a hand is attached to that hand's device, and a held one is not", () => {
  // The hand's anchor space sits at the controller's tip, a fixed step from the tracked device.
  const tip = new THREE.Matrix4().makeTranslation(0, -0.02, -0.05);
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.08, -0.03),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  const anchor = { space: "right-hand" as const, localMatrix: new Float64Array(local.elements) };
  const at = (x: number, turn: number) => {
    const device = new THREE.Matrix4().compose(
      new THREE.Vector3(x, 1.1, -0.3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, turn, -0.2)),
      new THREE.Vector3(1, 1, 1),
    );
    // Both in 32-bit floats, as the renderer has them.
    const pose = new Float32Array(device.clone().multiply(tip).multiply(local).elements);
    return {
      pose,
      devices: { "right-hand": { index: 4, pose: new Float32Array(device.elements) } },
    };
  };
  const first = at(0.2, 0.5);
  const attached = nativePanelAttachment(anchor, first.pose, first.devices)!;
  assertEquals(attached.index, 4);
  const expected = tip.clone().multiply(local).elements;
  for (let i = 0; i < 16; i++) assertAlmostEquals(attached.relative[i]!, expected[i]!, 1e-6);
  // Wherever the hand goes, the panel's place on the device stays put: SteamVR is told once.
  for (let i = 1; i <= 50; i++) {
    const next = at(0.2 + i * 0.0137, 0.5 + i * 0.0711);
    const relative = nativePanelAttachment(anchor, next.pose, next.devices)!.relative;
    for (let k = 0; k < 16; k++) assertAlmostEquals(relative[k]!, attached.relative[k]!, 2e-6);
  }

  assertEquals(nativePanelAttachment(undefined, first.pose, first.devices), null);
  assertEquals(nativePanelAttachment(anchor, first.pose, {}), null);
  const pair = {
    space: "left-ray" as const,
    points: [[0, 0, 0], [0, 0, 0]] as [number[], number[]],
  };
  assertEquals(nativePanelAttachment({ ...anchor, pair }, first.pose, first.devices), null);
  // A grab that has ended holds its window where it was let go until the scene catches up.
  const carried = { ...anchor, follow: true as const };
  assert(nativePanelAttachment(carried, first.pose, first.devices) != null);
  assertEquals(
    nativePanelAttachment(carried, first.pose, first.devices, new Set(["right-hand"])),
    null,
  );
});

Deno.test("each eye sees a point of the stereo group where it really is", () => {
  const center = [0.3, 1.2, -0.9];
  const radius = 0.2;
  const head = [0, 1.6, 0];
  const leftEye = [-0.032, 1.6, 0];
  const rightEye = [0.032, 1.6, 0];
  const quad = nativeStereoQuad(center, radius, head, leftEye, rightEye)!;
  const pose = new THREE.Matrix4().fromArray(quad.pose);
  assertAlmostEquals(pose.determinant(), 1, 1e-5);
  // The quad faces the head.
  const normal = new THREE.Vector3().setFromMatrixColumn(pose, 2);
  const toHead = new THREE.Vector3(...head).sub(new THREE.Vector3(...center)).normalize();
  assertAlmostEquals(normal.dot(toHead), 1, 1e-6);

  // A point of the group in front of the quad's plane, towards the viewer and off to a side.
  const point = new THREE.Vector3(...center).addScaledVector(normal, 0.12).add(
    new THREE.Vector3(0.05, -0.08, 0),
  );
  for (const [eye, camera] of [[leftEye, quad.left], [rightEye, quad.right]] as const) {
    const ndc = point.clone()
      .applyMatrix4(new THREE.Matrix4().fromArray(camera.viewMatrix))
      .applyMatrix4(new THREE.Matrix4().fromArray(camera.projectionMatrix));
    assert(Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && Math.abs(ndc.z) < 1, "inside the image");
    // Where SteamVR puts that texel: on the quad, `ndc` of the way from its centre to its edge.
    const drawn = new THREE.Vector3(ndc.x * quad.width / 2, ndc.y * quad.height / 2, 0)
      .applyMatrix4(pose);
    // From the eye, the drawn texel and the real point lie in the same direction.
    const eyePosition = new THREE.Vector3(...eye);
    const seen = drawn.sub(eyePosition).normalize();
    const real = point.clone().sub(eyePosition).normalize();
    assertAlmostEquals(seen.dot(real), 1, 1e-9);
  }
  // The two eyes disagree about where on the quad the point is: that difference is the depth.
  const x = (camera: typeof quad.left) =>
    point.clone().applyMatrix4(new THREE.Matrix4().fromArray(camera.viewMatrix))
      .applyMatrix4(new THREE.Matrix4().fromArray(camera.projectionMatrix)).x;
  assert(Math.abs(x(quad.left) - x(quad.right)) > 1e-3);
});

Deno.test("the stereo quad frames the whole sphere from both eyes, and gives up inside it", () => {
  const center = [0, 1.2, -0.6];
  const radius = 0.2;
  const quad = nativeStereoQuad(center, radius, [0, 1.5, 0], [-0.035, 1.5, 0], [0.035, 1.5, 0])!;
  for (const camera of [quad.left, quad.right]) {
    const view = new THREE.Matrix4().fromArray(camera.viewMatrix);
    const projection = new THREE.Matrix4().fromArray(camera.projectionMatrix);
    for (let i = 0; i < 200; i++) {
      // Points all over the sphere's surface.
      const a = i * 2.399963, y = 1 - 2 * (i + 0.5) / 200, r = Math.sqrt(1 - y * y);
      const ndc = new THREE.Vector3(
        center[0]! + radius * r * Math.cos(a),
        center[1]! + radius * y,
        center[2]! + radius * r * Math.sin(a),
      ).applyMatrix4(view).applyMatrix4(projection);
      assert(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1, `sphere point ${i} is cut off`);
      assert(Math.abs(ndc.z) <= 1, `sphere point ${i} is outside the depth range`);
    }
  }
  assertEquals(nativeStereoQuad(center, radius, [0, 1.25, -0.55], [0, 0, 0], [0, 0, 0]), null);
});

// ---- box outlines ----

const BOX: [number, number, number] = [0.9, 0.5, 0.04];
/** A grab box's frame somewhere in the room: turned, and scaled as a resized window is. */
function boxFrame(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(0.2, 1.4, -1.1),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.3, 0.05)),
    new THREE.Vector3(1.3, 1.3, 1.3),
  );
}
/** The twelve bars of `GrabBoxFrame`: meshes of the box's frame, evenly around its centre. */
function boxBars(frame = boxFrame(), materialId = 5) {
  const [hx, hy, hz] = BOX.map((size) => size / 2);
  const at: [number, number, number][] = [];
  for (const y of [-hy!, hy!]) for (const z of [-hz!, hz!]) at.push([0, y, z]);
  for (const x of [-hx!, hx!]) for (const z of [-hz!, hz!]) at.push([x, 0, z]);
  for (const x of [-hx!, hx!]) for (const y of [-hy!, hy!]) at.push([x, y, 0]);
  return at.map((position, index) => ({
    nodeId: 100 + index,
    geometryId: 10 + index,
    materialId,
    worldMatrix: new Float64Array(
      frame.clone().multiply(new THREE.Matrix4().makeTranslation(...position)).elements,
    ),
  }));
}
/** A point of the box, in the box's own units, in the world. */
const inBox = (x: number, y: number, z: number, frame = boxFrame()) =>
  new THREE.Vector3(x, y, z).applyMatrix4(frame);
/** The head `distance` m in front of the box's centre, `side` and `up` m off its axis. */
function viewer(distance: number, side = 0, up = 0, frame = boxFrame()) {
  const rotation = new THREE.Matrix4().extractRotation(frame);
  const center = new THREE.Vector3().setFromMatrixPosition(frame);
  const at = (x: number) =>
    new THREE.Vector3(side + x, up, distance).applyMatrix4(rotation).add(center).toArray();
  return { head: at(0), left: at(-0.032), right: at(0.032) };
}

Deno.test("a box outline's quad lies in its nearer face and shows every corner where it is", () => {
  const bars = boxBars();
  const eyes = viewer(1.2, 0.25, -0.1);
  const quad = nativeStereoBoxQuad(bars, BOX, eyes.head, eyes.left, eyes.right)!;
  assert(quad, "seen from the front, the box has a quad");
  const pose = new THREE.Matrix4().fromArray(quad.pose);
  assertAlmostEquals(pose.determinant(), 1, 1e-5);
  // In the front face: the box's centre plus half its depth along its own normal.
  const face = inBox(0, 0, BOX[2] / 2);
  const position = new THREE.Vector3().setFromMatrixPosition(pose);
  assert(position.distanceTo(face) < 1e-6, "the quad sits on the face nearer the head");
  const normal = new THREE.Vector3().setFromMatrixColumn(pose, 2);
  const boxNormal = new THREE.Vector3(0, 0, 1).transformDirection(boxFrame());
  assertAlmostEquals(normal.dot(boxNormal), 1, 1e-6);
  // A little larger than the face (which is 0.9 x 0.5 scaled by 1.3).
  assert(quad.width > 0.9 * 1.3 && quad.width < 0.9 * 1.3 + 0.12);
  assert(quad.height > 0.5 * 1.3 && quad.height < 0.5 * 1.3 + 0.12);

  for (const [eye, camera] of [[eyes.left, quad.left], [eyes.right, quad.right]] as const) {
    const eyePosition = new THREE.Vector3(...eye);
    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        for (const z of [-1, 1]) {
          const corner = inBox(x * BOX[0] / 2, y * BOX[1] / 2, z * BOX[2] / 2);
          const ndc = corner.clone()
            .applyMatrix4(new THREE.Matrix4().fromArray(camera.viewMatrix))
            .applyMatrix4(new THREE.Matrix4().fromArray(camera.projectionMatrix));
          assert(
            Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && Math.abs(ndc.z) < 1,
            `corner ${x},${y},${z} is inside the picture`,
          );
          // The texel SteamVR draws for it, seen from the eye, is where the corner really is.
          const drawn = new THREE.Vector3(ndc.x * quad.width / 2, ndc.y * quad.height / 2, 0)
            .applyMatrix4(pose);
          const seen = drawn.sub(eyePosition).normalize();
          assertAlmostEquals(seen.dot(corner.clone().sub(eyePosition).normalize()), 1, 1e-9);
        }
      }
    }
  }
});

Deno.test("a box outline's quad does not move with the head, and says when to draw again", () => {
  const bars = boxBars();
  const here = viewer(1.2, 0.25, -0.1), there = viewer(0.9, -0.3, 0.2);
  const first = nativeStereoBoxQuad(bars, BOX, here.head, here.left, here.right)!;
  const second = nativeStereoBoxQuad(bars, BOX, there.head, there.left, there.right)!;
  // SteamVR is told the quad's place once: it is the box's, whatever the head does.
  assertEquals(Array.from(second.pose), Array.from(first.pose));
  assertEquals([second.width, second.height], [first.width, first.height]);

  // A picture drawn from one place and looked at from `redrawAfter` further on is off by no more
  // than a third of a millimetre, even at the far face, where it is worst.
  const allowed = first.redrawAfter!;
  assert(allowed >= 0.002 && allowed < 0.05, `redraw after ${allowed} m`);
  const pose = new THREE.Matrix4().fromArray(first.pose);
  const eye = new THREE.Vector3(...here.left);
  const moved = eye.clone().addScaledVector(
    new THREE.Vector3(1, 0, 0).transformDirection(boxFrame()),
    allowed,
  );
  const corner = inBox(BOX[0] / 2, BOX[1] / 2, -BOX[2] / 2);
  const ndc = corner.clone()
    .applyMatrix4(new THREE.Matrix4().fromArray(first.left.viewMatrix))
    .applyMatrix4(new THREE.Matrix4().fromArray(first.left.projectionMatrix));
  const drawn = new THREE.Vector3(ndc.x * first.width / 2, ndc.y * first.height / 2, 0)
    .applyMatrix4(pose);
  const angle = drawn.clone().sub(moved).angleTo(corner.clone().sub(moved));
  const off = angle * corner.distanceTo(moved);
  assert(off < 0.00035, `stale by ${(off * 1000).toFixed(3)} mm after ${allowed} m`);
  assert(off > 0.0001, "and that is the bound, not far below it");
});

Deno.test("behind a box its quad is in the other face; from the side or too close there is none", () => {
  const bars = boxBars();
  const behind = viewer(-1.2);
  const quad = nativeStereoBoxQuad(
    bars,
    BOX,
    behind.head,
    behind.left.slice(),
    behind.right.slice(),
  )!;
  assert(quad, "seen from behind, the box has a quad");
  const pose = new THREE.Matrix4().fromArray(quad.pose);
  assert(
    new THREE.Vector3().setFromMatrixPosition(pose).distanceTo(inBox(0, 0, -BOX[2] / 2)) < 1e-6,
  );
  // It faces the viewer and is still a proper (unmirrored) frame.
  const boxNormal = new THREE.Vector3(0, 0, 1).transformDirection(boxFrame());
  assertAlmostEquals(new THREE.Vector3().setFromMatrixColumn(pose, 2).dot(boxNormal), -1, 1e-6);
  assertAlmostEquals(pose.determinant(), 1, 1e-5);

  // Far off to the side the far face slides out of any quad of this size: the caller falls back.
  const side = viewer(0.3, 2.5);
  assertEquals(nativeStereoBoxQuad(bars, BOX, side.head, side.left, side.right), null);
  const close = viewer(0.05);
  assertEquals(nativeStereoBoxQuad(bars, BOX, close.head, close.left, close.right), null);
  assertEquals(nativeStereoBoxQuad([], BOX, close.head, close.left, close.right), null);
  // The fallback's sphere holds the whole box, wherever tracking has put it.
  const sphere = nativeStereoBoxSphere(bars, BOX)!;
  assert(new THREE.Vector3(...sphere.center).distanceTo(inBox(0, 0, 0)) < 1e-6);
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      const corner = inBox(x * BOX[0] / 2, BOX[1] / 2, z * BOX[2] / 2);
      assert(corner.distanceTo(new THREE.Vector3(...sphere.center)) < sphere.radius);
    }
  }
});

Deno.test("a box outline goes native with the panels, and is redrawn only for what shows", () => {
  const scene = payload();
  const mark = { key: "grabbox-1", radius: 0.6, center: [0, 0, 0], box: BOX, withPanels: true };
  const bars = boxBars().map((bar) => ({ ...bar, nativeStereo: mark }));
  (scene.leftEye.frame.instances as unknown[]).push(...bars);
  // Without native panels the outline stays in the eye image with the UI it frames.
  const panorama = planNativeContent(scene, { panels: false, stereo: true })!;
  assertEquals(panorama.stereo.map((group) => group.key), ["cube"]);
  assertEquals(panorama.eyePayload.leftEye.frame.instances.length, 13);
  const native = planNativeContent(scene, { panels: true, stereo: true })!;
  assertEquals(native.stereo.map((group) => group.key), ["cube", "grabbox-1"]);
  const group = native.stereo[1]!;
  assertEquals(group.box, BOX);
  assertEquals(group.instances.length, 12);
  assertEquals(native.eyePayload.leftEye.frame.instances.length, 1);

  // Its picture: the same wherever the box stands, different once a bar changes material.
  const eyes = viewer(1.2);
  const quad = nativeStereoBoxQuad(group.instances, BOX, eyes.head, eyes.left, eyes.right)!;
  const hash = nativeStereoContentHash(group.instances, quad.pose);
  const elsewhere = new THREE.Matrix4().compose(
    new THREE.Vector3(-0.7, 1.1, 0.6),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 1.9, 0)),
    new THREE.Vector3(1.3, 1.3, 1.3),
  );
  const moved = boxBars(elsewhere);
  const movedEyes = viewer(1.2, 0, 0, elsewhere);
  const movedQuad = nativeStereoBoxQuad(
    moved,
    BOX,
    movedEyes.head,
    movedEyes.left,
    movedEyes.right,
  )!;
  assertEquals(nativeStereoContentHash(moved as never, movedQuad.pose), hash);
  assertNotEquals(nativeStereoContentHash(boxBars(boxFrame(), 6) as never, quad.pose), hash);
});

Deno.test("native panels travel over the wire, change the fingerprint and follow tracking", () => {
  const scene = payload();
  const decoded = new OverlaySceneWireDecoder().decode(new OverlaySceneWireEncoder().encode(scene));
  assert(!decoded.stale);
  const received = decoded.payload.ui.nativePanels!;
  assertEquals(received.length, 1);
  assertEquals(received[0]!.key, "ui-1");
  assertEquals(
    Array.from(received[0]!.worldMatrix),
    Array.from(scene.ui.nativePanels![0]!.worldMatrix),
  );

  const base = fingerprintScene(scene);
  const resized = payload();
  resized.ui.nativePanels![0]!.pixelWidth = 900;
  assertNotEquals(fingerprintScene(resized), base);
  const unmarked = payload();
  delete unmarked.ui.nativePanels;
  assertNotEquals(fingerprintScene(unmarked), base);

  // Carried by a hand: the renderer re-poses the plane from fresh tracking, like its items.
  const carried = payload();
  carried.ui.nativePanels![0]!.renderAnchor = {
    space: "right-ray",
    follow: true,
    localMatrix: new Float64Array(new THREE.Matrix4().makeTranslation(0, 0, -0.5).elements),
  };
  const hand = new THREE.Matrix4().makeTranslation(1, 2, 3).elements;
  resolveRenderAnchors(carried, { "right-ray": hand });
  assertEquals(Array.from(carried.ui.nativePanels![0]!.worldMatrix).slice(12, 15), [1, 2, 2.5]);
});
