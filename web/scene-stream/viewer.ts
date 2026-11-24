/// <reference lib="dom" />
/**
 * Browser renderer for PetPlay's scene stream (markdown/scene-stream, P4).
 *
 * A replica `SceneStore` receives binary deltas over a WebSocket and acks each one; a listener
 * on the replica keeps a three.js scene in step with exactly the rows that changed. Tracked nodes
 * (head, hands) take their poses from the separate pose messages.
 *
 * Input: every pointer and wheel event goes to the server with the camera this view drew, so it
 * picks exactly what the user sees. Navigation is not implemented here: the server runs PetPlay's
 * one desktop navigation (`classes/desktopNavigation.ts`, the same as the raylib viewers) for
 * this view and sends back the camera to render with.
 *
 * Video: `videoSurface` items show part of a media feed. The server lists its feeds in a
 * `{ media: { feeds } }` message; each is received with the media transport's own receiver
 * (`petplay_mediatransport/web/src/receiver.ts`, the stream page's code) over WebTransport and
 * uploaded once per new picture into a texture all surfaces of that feed share.
 */
import * as THREE from "npm:three@0.187.0";
import {
  decodeDelta,
  type RowId,
  SceneStore,
  StoreDivergence,
  type TrackedPair,
  type TrackedSpace,
} from "../../submodules/raythree/src/store/mod.ts";
import { cornerWristHud } from "../../classes/environment/wristMenu/hud.ts";
import { SceneView, viewState } from "./sceneView.ts";
import { type FeedInfo, MediaFeeds } from "./mediaFeeds.ts";

// ---- connection ----

const replica = new SceneStore();
const view = new SceneView(replica);
const stats = { deltas: 0, bytes: 0, resyncs: 0, lastDeltaBytes: 0, connected: false, pointerEvents: 0 };
let socket: WebSocket | null = null;

function connect(): void {
  const url = new URL("scene", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  socket = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => stats.connected = true;
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (message.poses) view.setPoses(message.poses);
      if (Array.isArray(message.view)) serverView.fromArray(message.view);
      if (message.mounts) setMounts(message.mounts);
      if (message.media?.feeds) updateFeeds(message.media.feeds);
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    stats.deltas++;
    stats.bytes += bytes.byteLength;
    stats.lastDeltaBytes = bytes.byteLength;
    try {
      const delta = decodeDelta(bytes);
      replica.apply(delta);
      ws.send(JSON.stringify({ ack: delta.toTick }));
    } catch (error) {
      if (!(error instanceof StoreDivergence)) console.error("scene-stream:", error);
      stats.resyncs++;
      ws.send(JSON.stringify({ resync: true }));
    }
  };
  ws.onclose = () => {
    stats.connected = false;
    if (socket === ws) socket = null;
    setTimeout(connect, 1000);
  };
}

// ---- media feeds ----

const mediaFeeds = new MediaFeeds(view, new URLSearchParams(location.search));
const feeds = mediaFeeds.feeds;
const updateFeeds = (listed: Record<string, FeedInfo>) => mediaFeeds.update(listed);
const presentFeeds = (now: number, replaced: VideoFrame[]) => mediaFeeds.present(now, replaced);

// ---- rendering ----

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const canvas = renderer.domElement;
canvas.addEventListener("webglcontextrestored", () => viewState.dirty = true);

const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 200);
camera.matrixAutoUpdate = false;
/** The camera the server's navigation for this view sends. */
const serverView = new THREE.Matrix4().makeTranslation(0, 1.2, 2);
/** F: follow the headset instead (local; navigating leaves it). */
let headView = false;

// ---- the wrist menu as a desktop HUD ----
//
// In the desktop view the wrist menu is a corner HUD (`wristMenu/hud.ts`): its carrying space is
// drawn so the menu's own frame lands bottom right in front of the camera, square to it. The
// server still has the menu on the hand, so a pointer over the HUD menu is sent with the camera
// moved by the same rigid map from the HUD placement back to the real grip: the server's ray then
// meets the real menu at the point the user aimed at.

let mounts: Partial<Record<TrackedSpace, THREE.Matrix4>> = {};
/** Per HUD space this frame: drawn pose · real pose⁻¹ inverted, i.e. real · drawn⁻¹. */
const hudToReal = new Map<TrackedSpace, THREE.Matrix4>();

function setMounts(list: Partial<Record<TrackedSpace, number[]>>): void {
  viewState.dirty = true;
  mounts = {};
  for (const [space, m] of Object.entries(list)) {
    if (m) mounts[space as TrackedSpace] = new THREE.Matrix4().fromArray(m);
  }
}

/** Per frame, before drawing: HUD spaces follow the camera in the desktop view. */
function placeHud(): void {
  hudToReal.clear();
  for (const space of Object.keys(view.drawnPoses) as TrackedSpace[]) delete view.drawnPoses[space];
  if (headView) return;
  const t = cornerWristHud(camera.fov, camera.aspect);
  const wristHud = new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotation)),
    new THREE.Vector3(...t.scale),
  );
  for (const [space, mount] of Object.entries(mounts) as [TrackedSpace, THREE.Matrix4][]) {
    const real = view.pose(space);
    if (!real) continue;
    // camera · hud = drawn · mount, so drawn = camera · hud · mount⁻¹.
    const drawn = camera.matrixWorld.clone().multiply(wristHud).multiply(mount.clone().invert());
    view.drawnPoses[space] = drawn;
    hudToReal.set(space, real.clone().multiply(drawn.clone().invert()));
  }
}

const hudRaycaster = new THREE.Raycaster();
/** Presses keep the camera mapping of their starting surface until released. */
const pointerSpaces = new Map<number, TrackedSpace | null>();

/** The HUD space under the pointer, if the pointer is over a HUD-placed menu. */
function hudSpaceAt(x: number, y: number): TrackedSpace | null {
  if (hudToReal.size === 0) return null;
  hudRaycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), camera);
  for (const space of hudToReal.keys()) if (view.raycastSpace(space, hudRaycaster)) return space;
  return null;
}

function resize(): void {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  viewState.dirty = true;
}
addEventListener("resize", resize);
resize();

function send(message: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function aim(position: THREE.Vector3, target: THREE.Vector3): boolean {
  return send({ aim: { position: position.toArray(), target: target.toArray() } });
}

/** Ignore distant world items when framing a scene without a display. */
const CONTENT_RADIUS = 10;

/**
 * The opening view, and G: face the largest visible display and orbit its centre.
 * With no display, frame the nearby world content around its largest surface.
 */
function frameContent(): boolean {
  view.scene.updateMatrixWorld(true);
  const placed = [...view.worldMeshes()].flatMap(({ mesh, kind }) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    if (box.isEmpty()) return [];
    const size = box.getSize(new THREE.Vector3())
      .multiply(new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld));
    return [{
      mesh, kind, box, area: size.x * size.y,
      position: box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld),
    }];
  });
  if (placed.length === 0) return false;
  const display = placed.reduce<(typeof placed)[number] | null>((largest, item) =>
    item.kind === "videoSurface" && item.area > (largest?.area ?? 0) ? item : largest, null);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanX = tanY * camera.aspect;
  if (display) {
    const { mesh, position: target, box } = display;
    const toward = surfaceHeading(mesh);
    const right = new THREE.Vector3(toward.z, 0, -toward.x);
    let distance = 0.25;
    // Fit the full surface in a level view, including its tilt and curvature.
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const offset = new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).sub(target);
          const fit = Math.max(Math.abs(offset.dot(right)) / tanX, Math.abs(offset.y) / tanY);
          distance = Math.max(distance, offset.dot(toward) + fit * 1.15 + camera.near);
        }
      }
    }
    return aim(target.clone().addScaledVector(toward, distance), target);
  }

  const median = (axis: "x" | "y" | "z") => {
    const values = placed.map((p) => p.position[axis]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  const middle = new THREE.Vector3(median("x"), median("y"), median("z"));
  const bounds = new THREE.Box3();
  let main: THREE.Mesh | null = null;
  let largest = 0;
  for (const { position, mesh, area } of placed) {
    if (position.distanceTo(middle) > CONTENT_RADIUS) continue;
    bounds.expandByPoint(position);
    if (area > largest) {
      largest = area;
      main = mesh;
    }
  }
  if (bounds.isEmpty() || !main) return false;
  const target = bounds.getCenter(new THREE.Vector3());
  // Far enough that the content's extent across the view fits, with a little room.
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.5);
  const position = target.clone().addScaledVector(surfaceHeading(main), (radius / Math.min(tanX, tanY)) * 1.1);
  return aim(position, target);
}

function surfaceHeading(mesh: THREE.Mesh): THREE.Vector3 {
  const toward = new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, 2).setY(0);
  return toward.lengthSq() < 1e-6 ? toward.set(0, 0, 1) : toward.normalize();
}

/** Leaves the head view where the head is, orbiting a point a metre ahead. */
function leaveHeadView(): void {
  const head = view.pose("viewer");
  headView = false;
  viewState.dirty = true;
  if (!head) return;
  const position = new THREE.Vector3().setFromMatrixPosition(head);
  const ahead = new THREE.Vector3(0, 0, -1).transformDirection(head).add(position);
  aim(position, ahead);
  serverView.copy(head); // until the server's answer arrives
}

// Open framed on the content: the headset may be facing anywhere. F switches to its view.
const opening = setInterval(() => {
  if (replica.size("items") > 0 && frameContent()) clearInterval(opening);
}, 200);

addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "g" || event.key === "G") {
    clearInterval(opening);
    if (frameContent() && headView) {
      headView = false;
      viewState.dirty = true;
    }
  } else if (event.key === "f" || event.key === "F") {
    clearInterval(opening);
    if (headView) leaveHeadView();
    else {
      headView = true;
      viewState.dirty = true;
    }
  }
});

// ---- input: all of it to the scene ----

let sequence = 0;

function sendPointer(
  type: "pointermove" | "pointerdown" | "pointerup" | "pointercancel" | "pointerleave" | "wheel",
  event: PointerEvent | WheelEvent,
  deltaY?: number,
): void {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const pointerId = "pointerId" in event ? event.pointerId : 1;
  // Over the HUD menu (or dragging from it): the camera as seen from the real grip's frame.
  const pressedSpace = pointerSpaces.get(pointerId);
  const space = pressedSpace === undefined ? hudSpaceAt(x, y) : pressedSpace;
  if (type === "pointerup" || type === "pointercancel" || type === "pointerleave") pointerSpaces.delete(pointerId);
  const map = space ? hudToReal.get(space) : undefined;
  const cameraWorld = map ? map.clone().multiply(camera.matrixWorld) : camera.matrixWorld;
  const sent = send({
    pointer: {
      version: 1,
      viewport: "scene-view",
      sequence: sequence++,
      type,
      pointerId,
      pointerType: "pointerType" in event && event.pointerType ? event.pointerType : "mouse",
      x,
      y,
      button: type === "pointermove" || type === "wheel" ? -1 : event.button,
      buttons: event.buttons,
      ...(deltaY !== undefined ? { deltaY } : {}),
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      camera: { matrixWorld: cameraWorld.toArray(), projection: camera.projectionMatrix.toArray() },
    },
  });
  if (sent) {
    stats.pointerEvents++;
    if (type === "pointerdown") pointerSpaces.set(pointerId, space);
  }
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerdown", (event) => {
  clearInterval(opening);
  // Navigation (decided by the server) moves the server's camera, not the headset's.
  if (headView) leaveHeadView();
  canvas.setPointerCapture(event.pointerId);
  sendPointer("pointerdown", event);
});
canvas.addEventListener("pointermove", (event) => sendPointer("pointermove", event));
canvas.addEventListener("pointerup", (event) => sendPointer("pointerup", event));
canvas.addEventListener("pointercancel", (event) => sendPointer("pointercancel", event));
canvas.addEventListener("pointerleave", (event) => sendPointer("pointerleave", event));
canvas.addEventListener("wheel", (event) => {
  clearInterval(opening);
  event.preventDefault();
  if (headView) leaveHeadView();
  sendPointer("wheel", event, event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY);
}, { passive: false });
// Leaving the page must not leave a press held in the scene.
addEventListener("blur", () => sendPointer("pointercancel", new PointerEvent("pointercancel", { pointerId: 1 })));

const hud = document.getElementById("hud")!;
let hudAt = 0;
const replacedFrames: VideoFrame[] = [];

function frame(now: number): void {
  requestAnimationFrame(frame);
  const head = view.pose("viewer");
  const nextCamera = headView && head ? head : serverView;
  const sceneChanged = viewState.dirty || !camera.matrix.equals(nextCamera);
  if (sceneChanged) {
    viewState.dirty = false;
    camera.matrix.copy(nextCamera);
    camera.matrixWorld.copy(nextCamera);
    camera.matrixWorldInverse.copy(nextCamera).invert();
    placeHud();
    view.update(camera);
  }
  const videoChanged = presentFeeds(now, replacedFrames);
  if (sceneChanged || videoChanged) {
    renderer.render(view.scene, camera);
    // Uploaded by the render above; the texture keeps the pixels.
    for (const frame of replacedFrames) frame.close();
    replacedFrames.length = 0;
  }
  if (now - hudAt > 250) {
    hudAt = now;
    hud.textContent = `${stats.connected ? "connected" : "connecting…"} · tick ${replica.sourceTick} · ` +
      `${replica.size("items")} items · ${stats.deltas} deltas, ${(stats.bytes / 1024).toFixed(0)} KiB ` +
      `(last ${stats.lastDeltaBytes} B) · ${headView ? "head view" : "desktop view"} · ` +
      `on empty space: left pan, right orbit, wheel zoom · Alt + drag display · F head · G frame` +
      [...feeds].map(([name, feed]) => ` · ${name}: ${feed.status}`).join("");
  }
}

/** For inspection from the console or a test harness. */
(globalThis as { sceneStream?: unknown }).sceneStream = {
  replica,
  view,
  camera,
  serverView,
  renderer,
  stats,
  feeds,
  THREE,
  /** Places this view's camera at `position` looking at `target` (the shared navigation). */
  aim: (position: THREE.Vector3Tuple, target: THREE.Vector3Tuple) =>
    aim(new THREE.Vector3(...position), new THREE.Vector3(...target)),
};

connect();
requestAnimationFrame(frame);
