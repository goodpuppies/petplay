/**
 * Smoke playtest: the everyday path, end to end, in `--novr`. Show the windows from the wrist,
 * move a window, resize it, type on the keyboard, open the window's settings, change a setting.
 *
 * Run with `deno task playtest smoke`. Steps run inside the `webxr` actor (see
 * `utils/playtest.ts`), so imports here resolve to the same modules the app uses.
 */
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import {
  type PlaytestContext,
  type PlaytestStep,
  WRIST_MAIN,
} from "../../utils/playtest.ts";
import {
  aim,
  display,
  laserClick,
  laserDrag,
  LEFT_ORIGIN,
  openSettings,
  RIGHT_ORIGIN,
  showWindows,
  squeeze,
  toolbarOf,
  worldOf,
} from "./lib/steps.ts";
import { onKeyboardEvent } from "../../classes/environment/keyboard/keyEvents.ts";
import type { KeyboardLogicEvent } from "../../classes/environment/keyboard/types.ts";
import { getSetting } from "../../classes/settings.ts";
import { setSettingsWindowOpen } from "../../classes/environment/settingsWindowStore.ts";

function settingsWindow(ctx: PlaytestContext): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  ctx.scene().traverse((object) => {
    if (!found && object.userData?.settingsWindowOverlay) found = object;
  });
  return found;
}

/** A setting row's ON or OFF pill: the one level with the row's title. */
function settingPill(
  ctx: PlaytestContext,
  title: string,
  label: "ON" | "OFF",
): THREE.Object3D | null {
  const root = settingsWindow(ctx);
  const heading = root && ctx.textObject(root, title);
  if (!root || !heading) return null;
  const y = heading.getWorldPosition(new THREE.Vector3()).y;
  let best: THREE.Object3D | null = null, bestDistance = Infinity;
  root.traverse((object) => {
    if (object.userData?.raythreeUiText?.text !== label) return;
    const distance = Math.abs(object.getWorldPosition(new THREE.Vector3()).y - y);
    if (distance < bestDistance) [best, bestDistance] = [object, distance];
  });
  return best;
}

export const steps: PlaytestStep[] = [
  showWindows,
  {
    name: "move-window",
    run: async (ctx) => {
      // Laser grab: squeeze on the window, slide the whole ray sideways, let go.
      const moved = await laserDrag(ctx, 0.25);
      ctx.note(`moved ${moved.toFixed(3)} m`);
      ctx.expect(moved > 0.1, `a laser grab moves the window (moved ${moved.toFixed(3)} m)`);
    },
  },
  {
    name: "resize-window",
    run: async (ctx) => {
      const { position: centre, right, scale } = worldOf(display(ctx));
      const before = scale.x;
      // Two-handed pinch: both lasers squeeze on the window, then spread apart.
      const at = (spread: number) => centre.clone().addScaledVector(right, spread);
      aim(ctx, "left", LEFT_ORIGIN, at(-0.1));
      aim(ctx, "right", RIGHT_ORIGIN, at(0.1));
      await ctx.settle();
      squeeze(ctx, "left", true);
      squeeze(ctx, "right", true);
      await ctx.frames(3);
      for (let i = 1; i <= 10; i++) {
        const spread = 0.1 + 0.05 * i / 10;
        aim(ctx, "left", LEFT_ORIGIN, at(-spread));
        aim(ctx, "right", RIGHT_ORIGIN, at(spread));
        await ctx.frames(1);
      }
      await ctx.frames(3);
      squeeze(ctx, "left", false);
      squeeze(ctx, "right", false);
      await ctx.settle();
      ctx.t.parkLeftHand();
      const after = worldOf(display(ctx)).scale.x;
      ctx.note(`scale ${before.toFixed(3)} -> ${after.toFixed(3)}`);
      ctx.expect(after > before * 1.2, "a two-handed spread makes the window bigger");
    },
  },
  {
    name: "type",
    run: async (ctx) => {
      const keyboard = ctx.nodeObject("keyboard");
      if (!ctx.expect(keyboard, "the keyboard is in the scene with the windows")) return;
      const typed: KeyboardLogicEvent[] = [];
      const stop = onKeyboardEvent((event) => typed.push(event));
      try {
        for (const legend of ["h", "i"]) {
          // Legends follow caps lock and the locale's casing.
          const cap = ctx.textObject(keyboard!, legend) ??
            ctx.textObject(keyboard!, legend.toUpperCase());
          if (!ctx.expect(cap, `the keyboard has an ${legend} key`)) continue;
          await ctx.clickObject(cap!, keyboard!);
        }
        await ctx.waitFor(() => typed.length >= 2, "two key presses reach the keyboard sink");
      } finally {
        stop();
      }
      ctx.note(
        `typed: ${
          typed.map((event) => event.kind === "key" ? event.char ?? event.scanCodeHex : event.kind)
            .join(" ")
        }`,
      );
    },
  },
  {
    // The toolbar of a selected window hangs through its hinged keyboard; past the keys it must
    // still take the click.
    name: "window-settings",
    run: async (ctx) => {
      // Typing left the keyboard selected; pointing at the window selects it again.
      if (!await openSettings(ctx)) return;
      ctx.expect(
        ctx.textObject(toolbarOf(display(ctx))!, "Opacity"),
        "the settings that opened are the window's own, not the keyboard's",
      );
    },
  },
  {
    // The wrist's Settings tile opens the floating Settings window (General tab first).
    name: "change-setting",
    run: async (ctx) => {
      const before = getSetting("grabboxOutline");
      await ctx.t.faceWristMenu();
      await ctx.t.clickWristMenu(WRIST_MAIN.settings);
      try {
        const opened = await ctx.waitFor(
          () => settingsWindow(ctx) != null,
          "the wrist's Settings opens the Settings window",
        );
        if (!opened) return;
        const flip = async (to: boolean, message: string) => {
          let pill: THREE.Object3D | null = null;
          const found = await ctx.waitFor(
            () => (pill = settingPill(ctx, "Grab-Box Outlines", to ? "ON" : "OFF")) != null,
            "the Settings window has a Grab-Box Outlines toggle",
          );
          if (!found) return false;
          await ctx.clickObject(pill!, settingsWindow(ctx)!);
          return ctx.waitFor(() => getSetting("grabboxOutline") === to, message);
        };
        if (await flip(!before, "the Settings window toggles the grab-box outline")) {
          await flip(before, "and toggles it back");
        }
      } finally {
        setSettingsWindowOpen(false);
      }
    },
  },
];
