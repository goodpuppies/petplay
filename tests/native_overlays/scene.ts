/**
 * The scene the native overlay checks draw: a UI panel (background, two corner markers, real MSDF
 * text) hanging turned and scaled in the room, a small cube marked as a native stereo group, well
 * in front of its group's centre so the two eyes must disagree about it, and a laser beam from the
 * hand to the panel with the dot where it lands. `origin` moves the whole arrangement, head
 * included.
 */
import * as THREE from "three";
import { anchoredLowerers } from "../../classes/overlayRenderTracking.ts";
import { extractWebXRRaythreeUi } from "../../classes/webxrRaythreeUi.ts";
import type { WebXRRaythreeUiPanelSnapshot } from "../../classes/webxrRaythreeUi.ts";
import type { WebXRRaythreeRenderPayload } from "../../classes/webxrRaythreeScene.ts";
import type { WebXRShadowFrame } from "../../classes/webxrhost.ts";
import { RaythreeExtractor } from "../../submodules/raythree/src/lib.ts";
import { MSDFTextGeometry } from "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/index.ts";

export const EYE = 512;
export const PANEL_WIDTH = 0.8, PANEL_HEIGHT = 0.5, PIXEL_SIZE = 0.001;
export const BACKGROUND = [0.1, 0.15, 0.2];
export const UPPER_LEFT = [0.9, 0.2, 0.2];
export const LOWER_RIGHT = [0.2, 0.9, 0.3];
export const IPD = 0.064;
/** The grab box around the panel, in the panel frame's units: the panel's size, 6 cm deep. */
export const BOX: [number, number, number] = [PANEL_WIDTH, PANEL_HEIGHT, 0.06];
/** How far the cube sits in front of its group's centre, along world +Z. */
export const CUBE_AHEAD = 0.12;
/** The laser, as petplayXrController.tsx draws it: a unit box scaled to 2 mm by its length. */
export const BEAM_THICKNESS = 0.002;
export const BEAM_COLOR = [0x5e / 255, 0xc8 / 255, 1];
export const DOT_RADIUS = 0.006;

/**
 * Adds a second panel, 0.3 x 0.2 m, that rides the head: `local` is its centre in head space.
 * Like the extractor's output for UI parented to the head, the root and its one item carry an
 * anchor; the renderer rebuilds their world matrices from tracking (`resolveRenderAnchors`).
 */
export function addHeadPanel(payload: WebXRRaythreeRenderPayload, local: THREE.Matrix4): void {
  const width = 0.3, height = 0.2;
  const square = local.clone().multiply(new THREE.Matrix4().makeScale(width, height, 0));
  const anchor = () => ({
    space: "head" as const,
    localMatrix: new Float64Array(square.elements),
  });
  const data = new Float32Array(16);
  data.set([0.9, 0.7, 0.1, 1], 4);
  data[14] = width / PIXEL_SIZE;
  data[15] = height / PIXEL_SIZE;
  payload.ui.panels.push({
    worldMatrix: new Float32Array(square.elements),
    data,
    clipping: new Float32Array([1, 0, 0, 1e6, -1, 0, 0, 1e6, 0, 1, 0, 1e6, 0, -1, 0, 1e6]),
    instanceIndex: 0,
    renderOrder: 0,
    depthTest: false,
    depthWrite: false,
    rootIndex: 8,
    renderAnchor: anchor(),
  });
  payload.ui.nativePanels!.push({
    key: "hud",
    rootIndices: [8],
    worldMatrix: new Float32Array(square.elements),
    pixelWidth: width / PIXEL_SIZE,
    pixelHeight: height / PIXEL_SIZE,
    renderAnchor: anchor(),
  });
}

export function createTestScene(origin = new THREE.Vector3()) {
  // The panel hangs somewhere in the room, turned and scaled: none of that may reach its texture.
  const panelWorld = new THREE.Matrix4().compose(
    new THREE.Vector3(0.3, 1.4, -1.2).add(origin),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.6, 0.1)),
    new THREE.Vector3(1.3, 1.3, 1.3),
  );
  const uiPanel = (
    index: number,
    color: number[],
    x: number,
    y: number,
    width: number,
    height: number,
    radius = 0,
  ): WebXRRaythreeUiPanelSnapshot => {
    const data = new Float32Array(16);
    data.set([...color, 1], 4);
    const r = Math.round(radius * 100);
    data[8] = r * (125000 + 2500 + 50 + 1);
    data[14] = width / PIXEL_SIZE;
    data[15] = height / PIXEL_SIZE;
    return {
      worldMatrix: new Float32Array(
        panelWorld.clone().multiply(
          new THREE.Matrix4().makeScale(width, height, 1).setPosition(x, y, 0),
        ).elements,
      ),
      data,
      clipping: new Float32Array([1, 0, 0, 1e6, -1, 0, 0, 1e6, 0, 1, 0, 1e6, 0, -1, 0, 1e6]),
      instanceIndex: index,
      renderOrder: index,
      depthTest: false,
      depthWrite: false,
      rootIndex: 7,
    };
  };

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  // Left of the panel as the eyes see it: the UI pass ignores depth and would paint over it.
  const cubeCenter = new THREE.Vector3(-0.45, 1.3, -0.9).add(origin);
  const cubeGroup = new THREE.Group();
  cubeGroup.position.copy(cubeCenter);
  cubeGroup.userData = { nativeStereoCenter: true };
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xff00ff }),
  );
  cube.position.set(0, 0, CUBE_AHEAD);
  cube.userData = { nativeStereo: { key: "cube", radius: 0.2 } };
  cubeGroup.add(cube);
  // A lit mesh beside it, on the group's plane: the stereo pass has to light it like the eyes do.
  const litCube = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x2fd3c2, roughness: 0.6, metalness: 0 }),
  );
  litCube.position.set(0.1, 0.06, 0);
  litCube.rotation.set(0.5, 0.65, 0);
  litCube.userData = { nativeStereo: { key: "cube", radius: 0.2 } };
  cubeGroup.add(litCube);
  scene.add(cubeGroup);

  // A grab box's outline around the panel, as `GrabBoxFrame` builds it: twelve bars, children of
  // the panel's frame, evenly around its centre. It goes native only with the panels.
  const boxGroup = new THREE.Group();
  panelWorld.decompose(boxGroup.position, boxGroup.quaternion, boxGroup.scale);
  const t = 0.004;
  const [hx, hy, hz] = BOX.map((size) => size / 2) as [number, number, number];
  const bars: { at: [number, number, number]; size: [number, number, number] }[] = [];
  for (const y of [-hy, hy]) {
    for (const z of [-hz, hz]) bars.push({ at: [0, y, z], size: [BOX[0] + t, t, t] });
  }
  for (const x of [-hx, hx]) {
    for (const z of [-hz, hz]) bars.push({ at: [x, 0, z], size: [t, BOX[1] + t, t] });
  }
  for (const x of [-hx, hx]) {
    for (const y of [-hy, hy]) bars.push({ at: [x, y, 0], size: [t, t, BOX[2] + t] });
  }
  const barMaterial = new THREE.MeshBasicMaterial({ color: 0x2060ff });
  for (const bar of bars) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...bar.size), barMaterial);
    mesh.position.set(...bar.at);
    mesh.userData = {
      raythreeHudOverUi: true,
      nativeStereo: { key: "box", radius: Math.hypot(...BOX) / 2, box: BOX, withPanels: true },
    };
    boxGroup.add(mesh);
  }
  scene.add(boxGroup);

  // The pointer: a beam from the hand to the middle of the panel, rolled about its own axis as a
  // controller would hold it, and the dot just short of where it lands, facing back along it.
  const beamFrom = new THREE.Vector3(0.18, 1.25, -0.15).add(origin);
  const beamTo = new THREE.Vector3().setFromMatrixPosition(panelWorld);
  const beamLength = beamFrom.distanceTo(beamTo);
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x5ec8ff, transparent: true, depthWrite: false }),
  );
  beam.position.copy(beamFrom).lerp(beamTo, 0.5);
  beam.lookAt(beamTo);
  beam.rotateZ(0.6);
  beam.scale.set(BEAM_THICKNESS, BEAM_THICKNESS, beamLength);
  beam.userData = {
    raythreeHudOverUi: true,
    nativeQuad: { key: "beam", shape: "beam", extent: [0.5, 0.5, 0.5] },
  };
  scene.add(beam);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  dot.position.copy(beamTo).lerp(beamFrom, 0.002 / beamLength);
  dot.lookAt(beamFrom);
  dot.scale.setScalar(DOT_RADIUS);
  dot.userData = {
    raythreeHudOverUi: true,
    nativeQuad: { key: "dot", shape: "flat", extent: [1, 1, 0] },
  };
  scene.add(dot);

  const font = JSON.parse(Deno.readTextFileSync(
    new URL(
      "../../submodules/threewebxrwebgpudeno/vendor/three-msdf-text-utils/demo/fonts/roboto/roboto-regular.fnt",
      import.meta.url,
    ),
  ));
  const label = "Native panel L>R";
  const textGeometry = new MSDFTextGeometry({ text: label, font });
  textGeometry.computeBoundingBox();
  const text = new THREE.Mesh(textGeometry, new THREE.MeshBasicMaterial());
  const textHolder = new THREE.Group();
  panelWorld.decompose(textHolder.position, textHolder.quaternion, textHolder.scale);
  text.position.set(-0.3, 0.02, 0);
  text.rotation.set(Math.PI, 0, 0);
  text.scale.setScalar(0.0009);
  text.userData = {
    bridge: { kind: "skip" },
    raythreeUiText: {
      text: label,
      font: "roboto",
      color: [1, 1, 1, 1],
      fontSize: 0.0009,
      align: "left",
      anchorX: "left",
      bounds: {
        minX: textGeometry.boundingBox!.min.x,
        maxX: textGeometry.boundingBox!.max.x,
        minY: textGeometry.boundingBox!.min.y,
        maxY: textGeometry.boundingBox!.max.y,
      },
    },
  };
  textHolder.add(text);
  scene.add(textHolder);
  scene.updateMatrixWorld(true);

  const headPosition = new THREE.Vector3(0, 1.6, 0).add(origin);
  const head = new THREE.Matrix4().makeTranslation(headPosition.x, headPosition.y, headPosition.z);
  const eyePose = (x: number) =>
    head.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0, 0));
  const leftEyePosition = new THREE.Vector3(-IPD / 2, 0, 0).add(headPosition);
  const rightEyePosition = new THREE.Vector3(IPD / 2, 0, 0).add(headPosition);
  const camera = new THREE.PerspectiveCamera(100, 1, 0.05, 20);
  camera.position.copy(headPosition);
  camera.updateMatrixWorld(true);
  const extraction = new RaythreeExtractor({ lowerers: anchoredLowerers() }).extract(scene, camera);
  const ui = extractWebXRRaythreeUi(scene);
  if (ui.texts.length !== 1) throw new Error(`Expected one text, got ${ui.texts.length}`);
  ui.texts[0]!.rootIndex = 7;
  ui.textRendering = { renderer: "msdf", panoramaFilter: "linear" } as typeof ui.textRendering;
  ui.panels = [
    uiPanel(0, BACKGROUND, 0, 0, PANEL_WIDTH, PANEL_HEIGHT, 0.04),
    uiPanel(1, UPPER_LEFT, -0.3, 0.17, 0.12, 0.08),
    uiPanel(2, LOWER_RIGHT, 0.3, -0.17, 0.12, 0.08),
  ];
  // As the extractor describes a uikit root: its matrix maps the unit square onto its rectangle.
  ui.nativePanels = [{
    key: "test",
    rootIndices: [7],
    worldMatrix: new Float32Array(
      panelWorld.clone().multiply(new THREE.Matrix4().makeScale(PANEL_WIDTH, PANEL_HEIGHT, 0))
        .elements,
    ),
    pixelWidth: PANEL_WIDTH / PIXEL_SIZE,
    pixelHeight: PANEL_HEIGHT / PIXEL_SIZE,
  }];

  const projection = new Float32Array(camera.projectionMatrix.elements);
  const frame = {
    frameCount: 1,
    eyeWidth: EYE,
    eyeHeight: EYE,
    outputWidth: EYE * 2,
    outputHeight: EYE * 2,
    lookRotation: new Float32Array(new THREE.Matrix4().elements),
    viewerPosition: new Float32Array(headPosition.toArray()),
    viewerQuaternion: new Float32Array([0, 0, 0, 1]),
    leftEyePosition: new Float32Array(leftEyePosition.toArray()),
    rightEyePosition: new Float32Array(rightEyePosition.toArray()),
    leftEyeQuaternion: new Float32Array([0, 0, 0, 1]),
    rightEyeQuaternion: new Float32Array([0, 0, 0, 1]),
    leftEyeViewMatrix: new Float32Array(eyePose(-IPD / 2).invert().elements),
    rightEyeViewMatrix: new Float32Array(eyePose(IPD / 2).invert().elements),
    leftEyeProjectionMatrix: projection,
    rightEyeProjectionMatrix: projection,
    halfFovInRadians: 0.87,
    ipdMeters: IPD,
  } as WebXRShadowFrame;
  const payload: WebXRRaythreeRenderPayload = {
    frame,
    background: [0, 0, 0, 0],
    leftEye: extraction,
    rightEye: extraction,
    ui,
  };
  return {
    payload,
    frame,
    head,
    headPosition,
    leftEyePosition,
    rightEyePosition,
    cubeCenter,
    panelWorld,
    beamFrom,
    beamTo,
  };
}
