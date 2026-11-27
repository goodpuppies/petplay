/**
 * Native overlays playtest: the scene side of `docs/NATIVE_OVERLAYS.md`, through the real React
 * tree and the real extractor. Every UI root on show (keyboard, its toolbar, wrist menu, Settings
 * window) is described as a native panel whose rectangle really frames all of its UI, the ones on
 * a hand say so, the display's rear logo stays in the eye image, the Debug page switches the
 * present mode and the test cubes, the grab boxes' outlines and the cube marked for a stereo quad
 * reach the renderer's plan while the other cube stays in the eye image, and a laser pointed at a
 * window brings its beam and its cursor dot as quads of their own. No SteamVR: what the renderer process does with
 * the plan is covered by `tests/native_overlays/`.
 *
 * Run with `deno task playtest native-overlays`.
 */
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import type { PlaytestContext, PlaytestStep } from "../../utils/playtest.ts";
import { WebXRRaythreeSceneBridge } from "../../classes/webxrRaythreeScene.ts";
import {
  nativeMeshQuad,
  nativePanelCamera,
  nativePanelContentHash,
  nativeStereoBoxQuad,
  planNativeContent,
} from "../../classes/nativeOverlayMath.ts";
import type {
  NativePanelSnapshot,
  NativeStereoInstance,
} from "../../classes/nativeOverlayContent.ts";
import type { Anchored } from "../../classes/overlayRenderTracking.ts";
import { getSetting, setSetting } from "../../classes/settings.ts";
import { getDebugCubeMode, setDebugCubeMode } from "../../classes/environment/debugCubeStore.ts";
import { setSettingsWindowOpen } from "../../classes/environment/settingsWindowStore.ts";
import { aim, RIGHT_ORIGIN, showWindows } from "./lib/steps.ts";

function settingsWindow(ctx: PlaytestContext): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  ctx.scene().traverse((object) => {
    if (!found && object.userData?.settingsWindowOverlay) found = object;
  });
  return found;
}

/** The pill reading `label` in the setting row titled `title`: the one level with the title. */
function rowPill(ctx: PlaytestContext, title: string, label: string): THREE.Object3D | null {
  const root = settingsWindow(ctx);
  const heading = root && ctx.textObject(root, title);
  if (!root || !heading) return null;
  const y = heading.getWorldPosition(new THREE.Vector3()).y;
  let best: THREE.Object3D | null = null, bestDistance = 0.02;
  root.traverse((object) => {
    if (object.userData?.raythreeUiText?.text !== label) return;
    const distance = Math.abs(object.getWorldPosition(new THREE.Vector3()).y - y);
    if (distance < bestDistance) [best, bestDistance] = [object, distance];
  });
  return best;
}

/** What the renderer process would be sent for this frame. */
function payload(ctx: PlaytestContext) {
  const context = (ctx.host as unknown as {
    getRaythreeSceneContext(): Parameters<WebXRRaythreeSceneBridge["buildPayload"]>[0];
  }).getRaythreeSceneContext();
  return new WebXRRaythreeSceneBridge().buildPayload(context, {} as never);
}

async function openSettings(ctx: PlaytestContext): Promise<boolean> {
  setSettingsWindowOpen(true);
  return await ctx.waitFor(
    () => {
      const root = settingsWindow(ctx);
      return root != null && ctx.textObject(root, "General") != null;
    },
    "the Settings window opens",
  );
}

async function openDebugPage(ctx: PlaytestContext): Promise<boolean> {
  if (!await openSettings(ctx)) return false;
  const root = settingsWindow(ctx)!;
  if (ctx.textObject(root, "Test Cube") != null) return true;
  const tab = ctx.textObject(root, "Debug");
  if (!ctx.expect(tab, "the Settings sidebar has a Debug category")) return false;
  await ctx.clickObject(tab!, root);
  return await ctx.waitFor(
    () => ctx.textObject(settingsWindow(ctx)!, "Test Cube") != null,
    "the Debug page opens",
  );
}

async function pressPill(ctx: PlaytestContext, title: string, label: string): Promise<boolean> {
  let pill: THREE.Object3D | null = null;
  const found = await ctx.waitFor(
    () => (pill = rowPill(ctx, title, label)) != null,
    `the ${title} row has a ${label} choice`,
  );
  if (!found) return false;
  await ctx.clickObject(pill!, settingsWindow(ctx)!);
  return true;
}

type Scene = ReturnType<typeof payload>;

/** The native panel whose root draws `text`. */
function panelWith(scene: Scene, text: string): NativePanelSnapshot | undefined {
  const item = scene.ui.texts.find((candidate) => candidate.text === text);
  return item && scene.ui.nativePanels?.find((panel) => panel.rootIndices.includes(item.rootIndex));
}

export const steps: PlaytestStep[] = [
  showWindows,
  {
    name: "every-ui-root-is-a-native-panel",
    run: async (ctx) => {
      if (!await openSettings(ctx)) return;
      await ctx.t.faceWristMenu();
      await ctx.settle();
      const scene = payload(ctx);
      const panels = scene.ui.nativePanels ?? [];
      ctx.expect(panels.length >= 4, `the UI roots on show are native panels (${panels.length})`);
      ctx.expect(
        new Set(panels.map((panel) => panel.key)).size === panels.length,
        "each with its own overlay name",
      );

      // Each rectangle really frames its root: every corner of every visible item lands inside
      // the texture. A root whose matrix did not span its rectangle would cut its UI off.
      const corner = new THREE.Vector3();
      for (const panel of panels) {
        const roots = new Set(panel.rootIndices);
        const uiPanels = scene.ui.panels.filter((item) => roots.has(item.rootIndex));
        const uiTexts = scene.ui.texts.filter((item) => roots.has(item.rootIndex));
        const camera = nativePanelCamera(panel);
        if (!ctx.expect(camera, `${panel.key} has a camera`)) continue;
        const toTexture = new THREE.Matrix4().fromArray(camera!.projectionMatrix).multiply(
          new THREE.Matrix4().fromArray(camera!.viewMatrix),
        );
        let worst = 0, depth = 0;
        for (const item of uiPanels) {
          // Fully transparent wrappers draw nothing, wherever they reach.
          if ((item.data[7] ?? 0) <= 0.001 && (item.data[12] ?? 0) <= 0.001) continue;
          const world = new THREE.Matrix4().fromArray(item.worldMatrix);
          for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
            corner.set(x!, y!, 0).applyMatrix4(world).applyMatrix4(toTexture);
            worst = Math.max(worst, Math.abs(corner.x), Math.abs(corner.y));
            depth = Math.max(depth, Math.abs(corner.z));
          }
        }
        ctx.note(
          `${panel.key}: ${panel.pixelWidth.toFixed(0)} x ${panel.pixelHeight.toFixed(0)} px, ` +
            `${camera!.widthMeters.toFixed(3)} m wide, texture ${camera!.textureWidth} x ` +
            `${camera!.textureHeight}, texel aspect ${camera!.texelAspect.toFixed(3)}, ` +
            `${panel.renderAnchor ? `on ${panel.renderAnchor.space}` : "in the room"}, ` +
            `${uiPanels.length} panels ${uiTexts.length} texts, reaching ` +
            `${(worst * 100).toFixed(1)}% of the way to the edge: "${
              uiTexts.slice(0, 3).map((text) => text.text).join(" ").slice(0, 28)
            }"`,
        );
        ctx.expect(worst <= 1.005, `nothing of ${panel.key} falls outside its texture`);
        ctx.expect(depth < 0.5, `and all of it is inside the depth range (${depth.toFixed(3)})`);
        // Its texture's size is rounded up to a step each way; the texel aspect makes up for it.
        const quadHeight = camera!.widthMeters * camera!.textureHeight / camera!.textureWidth /
          camera!.texelAspect;
        const panelHeight = Math.hypot(
          panel.worldMatrix[4]!,
          panel.worldMatrix[5]!,
          panel.worldMatrix[6]!,
        );
        ctx.expect(
          Math.abs(quadHeight - panelHeight) < 1e-4,
          `${panel.key}'s quad is as tall as the panel (${quadHeight.toFixed(4)} m, panel ` +
            `${panelHeight.toFixed(4)} m)`,
        );
        ctx.expect(
          camera!.textureWidth >= panel.pixelWidth * 2 - 1 &&
            camera!.textureHeight >= panel.pixelHeight * 2 - 1,
          `and has at least two texels per pixel`,
        );
      }

      const settings = panelWith(scene, "Overlay Mode");
      const keyboard = panelWith(scene, "esc");
      ctx.expect(settings, "the Settings window is one of them");
      ctx.expect(keyboard, "the keyboard is one of them");
      ctx.expect(settings && !settings.renderAnchor, "the Settings window hangs in the room");
      const onHand = panels.filter((panel) => panel.renderAnchor?.space.endsWith("-hand"));
      ctx.expect(onHand.length >= 1, `the wrist menu rides a hand (${onHand.length} panel(s))`);

      // The display's rear logo keeps to the eye image: it relies on backface culling there.
      const logo = scene.ui.images.find((image) => image.texture === "petplay");
      if (ctx.expect(logo, "the display has its rear logo")) {
        ctx.expect(
          !panels.some((panel) => panel.rootIndices.includes(logo!.rootIndex)),
          "the display's rear logo is not a native panel",
        );
      }

      const plan = planNativeContent(scene, { panels: true, stereo: false });
      if (!ctx.expect(plan, "a renderer in native mode gets a plan")) return;
      ctx.expect(
        plan!.eyePayload.ui.panels.length === 0 && plan!.eyePayload.ui.texts.length === 0,
        `the eye image draws no UI panels or text any more (${plan!.eyePayload.ui.panels.length} ` +
          `panels, ${plan!.eyePayload.ui.texts.length} texts left)`,
      );
      ctx.expect(
        plan!.eyePayload.ui.images.some((image) => image.texture === "petplay"),
        "except what opted out",
      );
      ctx.expect(
        (plan!.eyePayload.ui.depthOnlyPanels?.length ?? 0) >= 3,
        "and keeps the panels' backgrounds for the lasers' depth",
      );
      ctx.expect(
        planNativeContent(scene, { panels: false, stereo: false }) == null,
        "other present modes leave the scene as it is",
      );
      ctx.memo.keys = panels.map((panel) => panel.key).sort().join(",");
      ctx.memo.hashes = Object.fromEntries(plan!.panels.map((item) => [
        item.panel.key,
        nativePanelContentHash(item, nativePanelCamera(item.panel)!),
      ]));
    },
  },
  {
    // What keeps a quiet scene free: the same roots keep their overlay names from frame to frame,
    // and a hand moving under the wrist menu does not count as a new picture.
    name: "panels-stay-put-between-frames",
    run: async (ctx) => {
      await ctx.frames(6);
      const scene = payload(ctx);
      const keys = (scene.ui.nativePanels ?? []).map((panel) => panel.key).sort().join(",");
      ctx.expect(keys === ctx.memo.keys, `the same roots keep their names (${keys})`);
      const plan = planNativeContent(scene, { panels: true, stereo: false });
      const before = ctx.memo.hashes as Record<string, number>;
      // The wrist menu's clock may tick over; the room-placed panels have nothing that moves.
      for (const item of plan?.panels ?? []) {
        if (item.panel.renderAnchor) continue;
        ctx.expect(
          nativePanelContentHash(item, nativePanelCamera(item.panel)!) === before[item.panel.key],
          `${item.panel.key} needs no redraw while nothing on it changes`,
        );
      }
    },
  },
  {
    // The blue frames around windows: each is a group of twelve bars the renderer shows on a
    // stereo quad lying in the box's nearer face.
    name: "window-outlines-get-stereo-quads",
    run: async (ctx) => {
      await ctx.settle();
      const scene = payload(ctx);
      const plan = planNativeContent(scene, { panels: true, stereo: true });
      if (!ctx.expect(plan, "a renderer in native mode gets a plan")) return;
      const outlines = plan!.stereo.filter((group) => group.key.startsWith("grabbox-"));
      if (
        !ctx.expect(
          outlines.length >= 2,
          `grab boxes on show bring their outlines (${outlines.length})`,
        )
      ) {
        return;
      }
      ctx.expect(
        !plan!.eyePayload.leftEye.frame.instances.some((instance) =>
          (instance as NativeStereoInstance).nativeStereo?.key.startsWith("grabbox-")
        ),
        "and the eye image draws none of their bars any more",
      );
      const across = new THREE.Vector3(), normal = new THREE.Vector3(), eye = new THREE.Vector3();
      for (const group of outlines) {
        if (
          !ctx.expect(
            group.box && group.instances.length === 12,
            `${group.key} is twelve bars around a box`,
          )
        ) {
          continue;
        }
        // Seen from a metre in front of the box: the bars share the box's orientation, and its
        // scale (the keyboard's box is drawn smaller than its own units say).
        const frame = new THREE.Matrix4().fromArray(Array.from(group.instances[0]!.worldMatrix));
        const scale = across.setFromMatrixColumn(frame, 0).length();
        across.normalize();
        normal.setFromMatrixColumn(frame, 2).normalize();
        const center = new THREE.Vector3();
        for (const instance of group.instances) {
          center.add(
            eye.setFromMatrixPosition(
              new THREE.Matrix4().fromArray(Array.from(instance.worldMatrix)),
            ),
          );
        }
        center.divideScalar(group.instances.length);
        const from = (x: number) =>
          eye.copy(center).add(normal).addScaledVector(across, x).toArray();
        const quad = nativeStereoBoxQuad(
          group.instances,
          group.box!,
          from(0),
          from(-0.032),
          from(0.032),
        );
        ctx.note(
          `${group.key}: box ${group.box!.map((v) => (v * scale).toFixed(3)).join(" x ")} m` +
            (quad
              ? `, quad ${quad.width.toFixed(3)} x ${quad.height.toFixed(3)} m, redrawn after ` +
                `${((quad.redrawAfter ?? 0) * 1000).toFixed(1)} mm of eye travel`
              : ""),
        );
        ctx.expect(
          quad != null && quad.redrawAfter != null && quad.width > group.box![0] * scale &&
            quad.width < group.box![0] * scale * 1.2 && quad.height > group.box![1] * scale,
          `${group.key} gets a quad in its face that frames the box`,
        );
      }
      ctx.expect(
        (planNativeContent(scene, { panels: false, stereo: true })?.stereo ?? [])
          .every((group) => !group.key.startsWith("grabbox-")),
        "in the other present modes the outlines stay in the eye image, like the panels inside them",
      );
    },
  },
  {
    // What is left of the pointer once the panels are quads: the beam rides its controller, the
    // dot sits where the beam lands, and nothing drawn over the UI stays in the eye image.
    name: "laser-and-cursor-get-quads",
    run: async (ctx) => {
      if (!await openSettings(ctx)) return;
      const target = settingsWindow(ctx)!.getWorldPosition(new THREE.Vector3());
      aim(ctx, "right", RIGHT_ORIGIN, target);
      let plan: ReturnType<typeof planNativeContent> = null;
      const pointed = await ctx.waitFor(() => {
        plan = planNativeContent(payload(ctx), { panels: true, stereo: true });
        return (plan?.quads.length ?? 0) >= 2;
      }, "a laser on the Settings window brings quads for the pointer");
      if (!pointed) return;
      const scene = payload(ctx);
      plan = planNativeContent(scene, { panels: true, stereo: true })!;
      const beam = plan.quads.find((quad) => quad.shape === "beam");
      const dot = plan.quads.find((quad) => quad.shape === "flat");
      if (!ctx.expect(beam && dot, "a beam and a dot")) return;
      ctx.expect(
        (beam!.instance as Anchored).renderAnchor?.space === "right-ray",
        "the beam belongs to the right hand's ray, so it can ride that controller",
      );
      ctx.expect(
        (dot!.instance as Anchored).renderAnchor == null,
        "the dot stays where the scene put it",
      );
      const head = [0, 1.6, 0];
      const beamQuad = nativeMeshQuad(beam!.instance.worldMatrix, "beam", beam!.extent, head);
      const dotQuad = nativeMeshQuad(dot!.instance.worldMatrix, "flat", dot!.extent, head);
      if (!ctx.expect(beamQuad && dotQuad, "both get a quad")) return;
      const distance = RIGHT_ORIGIN.distanceTo(target);
      ctx.note(
        `${beam!.key}: ${beamQuad!.width.toFixed(3)} m x ${
          (beamQuad!.height * 1000).toFixed(1)
        } mm, ` +
          `texture ${beamQuad!.textureWidth} x ${beamQuad!.textureHeight}, texel aspect ` +
          `${beamQuad!.texelAspect.toFixed(2)}; ${dot!.key}: ${
            (dotQuad!.width * 1000).toFixed(1)
          } mm ` +
          `across; hand to window ${distance.toFixed(3)} m`,
      );
      ctx.expect(
        Math.abs(beamQuad!.width - distance) < 0.15 && Math.abs(beamQuad!.height - 0.008) < 1e-6,
        "the beam's quad runs from the hand to the window, four beam widths tall",
      );
      ctx.expect(
        beamQuad!.texelAspect >= 0.4 && beamQuad!.texelAspect <= 2.5,
        "with texels within reach of square",
      );
      ctx.expect(dotQuad!.width > 0.006 && dotQuad!.width < 0.04, "the dot's quad is a dot's size");
      const overUi = plan.eyePayload.leftEye.frame.instances.filter((instance) =>
        instance.hudOverUi
      );
      ctx.expect(
        overUi.length === 0,
        `nothing drawn over the UI is left in the eye image (${overUi.length})`,
      );
      ctx.expect(
        (planNativeContent(scene, { panels: false, stereo: true })?.quads.length ?? 0) === 0,
        "in the other present modes the pointer stays in the eye image with the UI",
      );
    },
  },
  {
    name: "debug-page-switches-mode",
    run: async (ctx) => {
      const before = getSetting("overlayPresentMode");
      try {
        if (!await openDebugPage(ctx)) return;
        if (!await pressPill(ctx, "Overlay Mode", "NATIVE")) return;
        await ctx.waitFor(
          () => getSetting("overlayPresentMode") === "native",
          "NATIVE selects the native present mode",
        );
        if (!await pressPill(ctx, "Overlay Mode", "PANO")) return;
        await ctx.waitFor(
          () => getSetting("overlayPresentMode") === "panorama",
          "and PANO goes back to the panorama",
        );
      } finally {
        setSetting("overlayPresentMode", before);
      }
    },
  },
  {
    name: "test-cubes",
    run: async (ctx) => {
      try {
        if (!await openDebugPage(ctx)) return;
        if (!await pressPill(ctx, "Test Cube", "BOTH")) return;
        if (!await ctx.waitFor(() => getDebugCubeMode() === "both", "BOTH shows both cubes")) {
          return;
        }
        let cubes: THREE.Object3D | null = null;
        const shown = await ctx.waitFor(() => {
          cubes = null;
          ctx.scene().traverse((object) => {
            if (!cubes && object.userData?.debugTestCubes) cubes = object;
          });
          return cubes != null;
        }, "the cubes are in the scene");
        if (!shown) return;
        await ctx.settle();

        const scene = payload(ctx);
        const marked = scene.leftEye.frame.instances.filter((instance) =>
          (instance as NativeStereoInstance).nativeStereo?.key === "debug-cube"
        );
        ctx.expect(
          marked.length === 4,
          `the teal cube and its studs are marked (${marked.length})`,
        );
        const plan = planNativeContent(scene, { panels: false, stereo: true });
        if (!ctx.expect(plan?.stereo.length === 1, "they form one stereo group")) return;
        const group = plan!.stereo[0]!;
        ctx.expect(group.instances.length === 4, "holding all four meshes");
        ctx.expect(
          plan!.eyePayload.leftEye.frame.instances.length ===
            scene.leftEye.frame.instances.length - 4,
          "the eye image keeps everything else, the orange cube included",
        );
        // Every marked mesh is inside the sphere the quad is sized for.
        const center = new THREE.Vector3(...group.center);
        let farthest = 0;
        for (const instance of group.instances) {
          const e = instance.worldMatrix;
          farthest = Math.max(
            farthest,
            center.distanceTo(new THREE.Vector3(Number(e[12]), Number(e[13]), Number(e[14]))),
          );
        }
        ctx.note(
          `group centre ${group.center.map((v) => v.toFixed(2))}, radius ${group.radius}, ` +
            `farthest mesh centre ${farthest.toFixed(3)} m`,
        );
        ctx.expect(farthest < group.radius, "the group's sphere holds its meshes");

        if (!await pressPill(ctx, "Test Cube", "OFF")) return;
        await ctx.waitFor(() => getDebugCubeMode() === "off", "OFF removes them");
        await ctx.settle();
        ctx.expect(
          planNativeContent(payload(ctx), { panels: false, stereo: true }) == null,
          "and nothing native is left in the scene",
        );
      } finally {
        setDebugCubeMode("off");
        setSettingsWindowOpen(false);
      }
    },
  },
];
