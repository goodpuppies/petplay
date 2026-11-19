// Scene-stream P0 measurement against a running vrlab (`deno task vrlab up --no-vrchat`):
//   deno run -A --no-check utils/scene-stream-probe/run.ts [--probe=store.js] [output.json]
// probe.js measures today's payload; store.js mirrors it into a SceneStore and replica.
// Phases: idle with full UI, right-hand sweep (wrist menu attached), left-hand sweep (ray).
import { NativeInteractionRig } from "../vrlab/interaction.ts";
import { evalIn, showWindowLayer } from "../vrlab/petplay.ts";
import type { Hand, HandPose } from "../vrlab/driver.ts";

const here = new URL(".", import.meta.url).pathname;
const probeName = Deno.args.find((a) => a.startsWith("--probe="))?.slice(8) ?? "probe.js";
const probe = await Deno.readTextFile(`${here}${probeName}`);
const parse = (s: string) => JSON.parse(s.startsWith("'") ? s.slice(1, -1).replace(/\\'/g, "'") : s);
const runProbe = async () => parse(await evalIn("webxr", probe, 20_000));

const rig = await NativeInteractionRig.attach();
const out: Record<string, unknown> = {};
try {
  await rig.calibrateRay("left");
  await rig.calibrateRay("right");
  await rig.faceWrist();
  await showWindowLayer();
  await new Promise((r) => setTimeout(r, 1500));
  out.idle = await runProbe();

  const sweep = async (hand: Hand) => {
    const base = await rig.driver.handPose(hand);
    // 1 Hz, ±20 cm sideways: the baseline sweep from raythree-retained-ir/baseline.md.
    const path = (t: number): HandPose => ({
      position: [base.position[0] + 0.2 * Math.sin(2 * Math.PI * t), base.position[1], base.position[2]],
      rotation: base.rotation,
    });
    const moving = rig.driver.follow(hand, 8, path);
    await new Promise((r) => setTimeout(r, 500));
    const result = await runProbe();
    await moving;
    await rig.driver.setPose(hand, base);
    return result;
  };
  out.sweepRight = await sweep("right");
  out.sweepLeft = await sweep("left");
} finally {
  await rig.restore().catch((e) => console.error("restore:", e));
  rig.driver.close();
}
const output = Deno.args.find((a) => !a.startsWith("--")) ?? "_scratch/scene-stream-probe.json";
await Deno.writeTextFile(output, JSON.stringify(out, null, 1));
console.log("wrote", output);
