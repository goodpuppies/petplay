/** Reopen the Stream camera without restarting VRChat. See --help. */
import { type Hand, SyntheticDriver } from "./vrlab/driver.ts";
import { ACTION_MENU, MENU_OPEN_POSE, MENU_VIEW_POSE, pickActionMenu } from "./vrlab/camera.ts";
import { oscQuery, sendOsc } from "./vrlab/vrchat.ts";
import { setDashboard } from "./vrlab/steamvr.ts";
import { desktopEnv, sleep } from "./vrlab/util.ts";
import { message } from "./vrlab/petplay.ts";
import { AvatarBlockLink } from "../classes/vrchatDepth/blockLayout.ts";

if (Deno.args.includes("--help")) {
  console.log(
    `deno task vrlab:camera-recover [--hand=right|left] [--page=root|tools] [--menu-open] [--settle-ms=3500]
Close any Quick Menu first. Default: right hand, closed radial on root page.
An already-open camera is preserved and switched to Stream without menu inputs.
--menu-open skips the menu-button toggle; --page=tools skips the Tools selection.
Checks camera mode after each selection, restores the depth layout and verifies fresh decoding.
Colour options: --bits=1..4 --inset=0..64; CyberLove uses --bits=2 --inset=48.
Does not restart VRChat. A decode failure is reported separately from camera-opening success.`,
  );
  Deno.exit(0);
}
const option = (name: string, fallback: string) =>
  Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const hand = option("hand", "right") as Hand;
const page = option("page", "root");
const settleMs = Number(option("settle-ms", "3500"));
const bits = Number(option("bits", "4"));
const levelInset = Number(option("inset", "16"));
if (
  ![1, 2, 3, 4].includes(bits) || !Number.isInteger(levelInset) || levelInset < 0 || levelInset > 64
) {
  throw new Error("Use --bits=1..4 and --inset=0..64 (CyberLove: --bits=2 --inset=48)");
}
if (
  !["left", "right"].includes(hand) || !["root", "tools"].includes(page) ||
  !Number.isFinite(settleMs) || settleMs < 2000 || settleMs > 15000
) {
  throw new Error("Invalid hand/page/settle-ms; see --help");
}
for (const [key, value] of Object.entries(desktopEnv())) {
  if (!Deno.env.get(key)) Deno.env.set(key, value);
}
const mode = async () => Number((await oscQuery("/usercamera/Mode"))?.[0] ?? 0);
const driver = await SyntheticDriver.attach();
let opened = false;
try {
  await setDashboard(driver, false);
  await driver.setInput("left", {});
  await driver.setInput("right", {});
  if (await mode() === 0) {
    if (!Deno.args.includes("--menu-open")) {
      await driver.setPose(hand, MENU_OPEN_POSE);
      await driver.press(hand, { b: true }, 1100);
      await sleep(settleMs);
    }
    await driver.setPose(hand, MENU_VIEW_POSE);
    if (page === "root") {
      await pickActionMenu(driver, ACTION_MENU.tools, settleMs, 1100, hand);
      // Root and Tools use similar directions. If already on Tools this opened Camera.
      opened = await mode() !== 0;
    }
    if (!opened) await pickActionMenu(driver, ACTION_MENU.camera, settleMs, 1100, hand);
    if (await mode() === 0) {
      throw new Error(
        `Camera did not open on ${hand}. Check radial hand/page and rerun with --menu-open --page=tools if appropriate.`,
      );
    }
  }
  await sendOsc("/usercamera/Mode", { i: 2 });
  await sleep(settleMs);
  if (await mode() !== 2) throw new Error("Camera opened but Stream mode was not confirmed");
  console.log("Stream camera verified (mode 2)");
} finally {
  await driver.setInput("left", {});
  await driver.setInput("right", {});
  // Menu selection leaves a 45-degree pointing pose; restore a forward interaction ray.
  await driver.setPose("right", {
    position: [0, 1.6, -0.7],
    rotation: [0.34289780745545134, 0, 0, 0.9393727128473789],
  });
  await driver.setPose("left", { position: [-0.3, 1.2, -0.2], rotation: [0, 0, 0, 1] });
  driver.close();
}
const link = new AvatarBlockLink();
try {
  await link.send({
    target: 1,
    originX: 8,
    originY: 8,
    cellPx: 1,
    gridWidth: 1024,
    depthSize: 512,
    bits,
    calibration3D: 1,
    levelInset,
  });
} finally {
  link.close();
}
// The live GPU capture is the real consumer; require its counter to advance, not old cache data.
const status = async () => (await message("main", "VRCCAMERAVIEWSTATUS")).details;
const first = (await status()).gpuCapture?.decoded ?? 0;
let healthy = false;
for (let attempt = 0; attempt < 10; attempt++) {
  await sleep(2000);
  const s = await status();
  if ((s.gpuCapture?.decoded ?? 0) > first && !s.gpuCapture?.lastFailure && !s.lastError) {
    console.log(
      JSON.stringify({
        stream: true,
        depth: true,
        fps: s.windowFps,
        decoded: s.gpuCapture.decoded,
        lightVolumes: s.lightVolumes,
      }),
    );
    healthy = true;
    if (!Deno.args.includes("--keep-camera")) {
      console.log(
        "Camera returned to avatar",
        await message("vrcCameraView", "DEPTHDEBUGHOME", null),
      );
    }
    break;
  }
}
if (!healthy) {
  const s = await status();
  console.error(
    JSON.stringify({
      stream: true,
      depth: false,
      capture: s.gpuCapture,
      error:
        "Camera is open; depth decoding needs investigation. No further menu toggles were sent.",
    }),
  );
}
Deno.exit(healthy ? 0 : 2);
