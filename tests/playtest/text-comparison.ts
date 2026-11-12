/** In-VR comparison controls through synthetic controller clicks, on an isolated --novr server. */
import type { PlaytestContext, PlaytestStep } from "../../utils/playtest.ts";
import { WRIST_MAIN } from "../../utils/playtest.ts";
import { getSetting } from "../../classes/settings.ts";
import { extractWebXRRaythreeUi } from "../../classes/webxrRaythreeUi.ts";
import type * as THREE from "three";

async function click(ctx: PlaytestContext, label: string) {
  const target = ctx.textObject(ctx.scene(), label);
  if (!ctx.expect(target, `visible ${label} control exists`)) return false;
  let face = target!;
  while (face.parent && face.userData?.wristMenuActor === undefined) face = face.parent;
  await ctx.clickObject(target!, face);
  return true;
}

export const steps: PlaytestStep[] = [{
  name: "compare-text-in-vr",
  run: async (ctx) => {
    await ctx.t.faceWristMenu();
    await ctx.t.clickWristMenu(WRIST_MAIN.settings);
    if (!await click(ctx, "TEXT")) return;
    await ctx.waitFor(
      () => ctx.textObject(ctx.scene(), "TEXT COMPARISON"),
      "Text comparison page opens",
    );
    const sample = ctx.textObject(ctx.scene(), "@@@ @example.fi");
    if (!ctx.expect(sample, "@ comparison sample is visible")) return;
    const original = Array.from(sample!.matrixWorld.elements);
    for (
      const [label, setting, value] of [
        ["VECTOR", "textRenderer", "pathfinder"],
        ["GLYPH", "textRenderer", "glyph"],
        ["WIND", "textRenderer", "windfoil"],
        ["GLYPH", "textRenderer", "glyph"],
        ["0.85", "glyphCoverageExponent", 0.85],
        ["0.125", "glyphWeightPixels", 0.125],
        ["85%", "glyphAaWidth", 0.85],
        ["70%", "glyphAaWidth", 0.7],
        ["100%", "glyphAaWidth", 1],
        ["0.70", "glyphCoverageExponent", 0.7],
        ["0.25", "glyphWeightPixels", 0.25],
        ["1.00", "glyphCoverageExponent", 1],
        ["0", "glyphWeightPixels", 0],
        ["LINEAR", "panoramaFilter", "linear"],
        ["MSDF", "textRenderer", "msdf"],
        ["SHARP", "panoramaFilter", "catmull-rom"],
        ["VECTOR", "textRenderer", "pathfinder"],
      ] as const
    ) {
      if (!await click(ctx, label)) return;
      await ctx.waitFor(
        () => getSetting(setting) === value,
        `${label} changes the rendering setting`,
      );
      const ui = extractWebXRRaythreeUi(ctx.scene() as THREE.Scene);
      ctx.expect(
        ui.textRendering?.renderer === getSetting("textRenderer"),
        "selected renderer enters the IR",
      );
      ctx.expect(
        ui.textRendering?.glyphCoverageExponent === getSetting("glyphCoverageExponent") &&
          ui.textRendering?.glyphWeightPixels === getSetting("glyphWeightPixels") &&
          ui.textRendering?.glyphAaWidth === getSetting("glyphAaWidth"),
        "independent coverage and weight settings enter the IR",
      );
      const current = ctx.textObject(ctx.scene(), "@@@ @example.fi");
      ctx.expect(current === sample, "sample mesh stays mounted between comparisons");
      ctx.expect(
        JSON.stringify(Array.from(current!.matrixWorld.elements)) === JSON.stringify(original),
        "sample dimensions and placement stay fixed",
      );
    }
    if (!await click(ctx, "NEAR")) return;
    let probe: THREE.Object3D | null = null;
    ctx.scene().traverse((object) => {
      if (object.userData?.textProbeDistance === "near") probe = object;
    });
    if (ctx.expect(probe, "near probe is present")) {
      const object = probe as unknown as THREE.Object3D;
      ctx.expect(
        object.position.z === -0.35 && object.scale.x === 0.35,
        "near displacement and scale match",
      );
    }
    if (!await click(ctx, "FAR")) return;
    probe = null;
    ctx.scene().traverse((object) => {
      if (object.userData?.textProbeDistance === "far") probe = object;
    });
    if (ctx.expect(probe, "far probe is present")) {
      const object = probe as unknown as THREE.Object3D;
      ctx.expect(
        object.position.z === -1.4 && object.scale.x === 1.4,
        "far displacement and scale match",
      );
    }
    await click(ctx, "BACK");
    await ctx.waitFor(() => ctx.textObject(ctx.scene(), "SETTINGS"), "Back returns to settings");
    let visibleProbe = false;
    ctx.scene().traverse((object) => {
      if (object.userData?.textDistanceProbe && object.visible) visibleProbe = true;
    });
    ctx.expect(!visibleProbe, "leaving the comparison page hides the probe");
  },
}];
