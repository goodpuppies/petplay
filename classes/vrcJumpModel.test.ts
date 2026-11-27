import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { DEFAULT_VRC_JUMP, fitJump, VrcJumpModel } from "./vrcJumpModel.ts";
import { VrcRootPredictor } from "./vrcOriginTransform.ts";

const GROUND = 0.195;

/** A VRChat jump's root heights as they arrive: ticks every `tickMs`, quantised like v2 fine. */
function jumpSamples(start: number, v0: number, g: number, tickMs = 20): [number, number][] {
  const out: [number, number][] = [];
  const flight = (2 * v0 / g) * 1000;
  for (let t = tickMs; t < flight + tickMs; t += tickMs) {
    const u = Math.min(t, flight) / 1000;
    const y = GROUND + Math.max(0, v0 * u - 0.5 * g * u * u);
    out.push([start + t, Math.round(y * 256) / 256]);
  }
  return out;
}

Deno.test("fitJump recovers launch speed, gravity and takeoff", () => {
  const air = jumpSamples(1000, 2.9, 9.6).filter(([, y]) => y > GROUND + 0.01);
  const fit = fitJump(air, GROUND)!;
  assertAlmostEquals(fit.launchSpeed, 2.9, 0.1);
  assertAlmostEquals(fit.gravity, 9.6, 0.5);
  assertAlmostEquals(fit.takeoff, 1000, 15);
});

Deno.test("jump model: learns a world's jump from a few jumps", () => {
  // A low-gravity world with a strong jump: 4 m/s, 6 m/s², takeoff 30 ms after the press.
  const model = new VrcJumpModel();
  let t = 0;
  for (let jump = 0; jump < 6; jump++) {
    model.press(t, GROUND);
    for (const [ts, y] of jumpSamples(t + 30, 4, 6)) {
      model.update(ts);
      model.measure(ts, y);
    }
    model.update(t + 3000);
    assert(!model.active, `jump ${jump} ended`);
    t += 5000;
  }
  assertAlmostEquals(model.params.launchSpeed, 4, 0.25);
  assertAlmostEquals(model.params.gravity, 6, 0.5);
  assertAlmostEquals(model.params.delayMs, 30, 20);
  assertEquals(model.params.misses, 0);
});

Deno.test("jump model: presses that never leave the ground disable it, a real jump re-enables", () => {
  const model = new VrcJumpModel();
  let t = 0;
  for (let i = 0; i < 3; i++, t += 2000) {
    model.press(t, GROUND);
    // No samples: the root never moved. The arc gives up soon after the takeoff time.
    assertEquals(model.update(t + 200), "abandoned");
  }
  assert(!model.enabled, "three misses disable predicted arcs");
  model.press(t, GROUND);
  assertEquals(model.at(t + 100), null, "while disabled the arc is only watched");
  for (const [ts, y] of jumpSamples(t, 2.9, 9.6)) {
    model.update(ts);
    model.measure(ts, y);
  }
  model.update(t + 2000);
  assert(model.enabled, "a jump that happened turns prediction back on");
  assertEquals(model.params.jumps, 1);
});

Deno.test("predictor: the jump press cuts the arc's error against a velocity filter", () => {
  const run = (withPress: boolean) => {
    const predictor = new VrcRootPredictor();
    predictor.jump.params = { ...DEFAULT_VRC_JUMP };
    let t = 0;
    for (; t < 500; t += 20) {
      predictor.setInput({ t, move: [0, 0], turn: 0, headYawRate: 0, jump: false });
      predictor.add({
        t,
        pose: {
          source: "petplay-origin-v2",
          position: [4, GROUND + 1e-4 * Math.sin(t), -5],
          yawRad: 0,
        },
      });
    }
    const start = t;
    const samples = jumpSamples(start, 2.9, 9.6);
    const truth = (tt: number) => {
      const u = Math.min(Math.max(0, tt - start), 604) / 1000;
      return GROUND + Math.max(0, 2.9 * u - 4.8 * u * u);
    };
    let i = 0;
    let maxErr = 0;
    let below = 0;
    for (; t < start + 1200; t += 5) {
      predictor.setInput({
        t,
        move: [0, 0],
        turn: 0,
        headYawRate: 0,
        jump: withPress && t < start + 150,
      });
      while (i < samples.length && samples[i][0] <= t) {
        predictor.add({
          t: samples[i][0],
          pose: { source: "petplay-origin-v2", position: [4, samples[i][1], -5], yawRad: 0 },
        });
        i++;
      }
      const y = predictor.display(t).pose.position[1];
      maxErr = Math.max(maxErr, Math.abs(y - truth(t)));
      below = Math.max(below, GROUND - y);
    }
    return { maxErr, below };
  };
  const filter = run(false);
  const arc = run(true);
  console.log(
    `max error: filter ${filter.maxErr.toFixed(3)} m (${
      filter.below.toFixed(3)
    } m below ground), arc ${arc.maxErr.toFixed(3)} m`,
  );
  assert(
    arc.maxErr < filter.maxErr / 2,
    `arc ${arc.maxErr.toFixed(3)} m vs filter ${filter.maxErr.toFixed(3)} m`,
  );
  assert(arc.below < 0.01, `the arc must not sink below the ground (${arc.below.toFixed(3)} m)`);
});

Deno.test("predictor: jumping onto a higher ledge lands on the ledge instead of plunging to old ground", () => {
  const predictor = new VrcRootPredictor();
  predictor.jump.params = { ...DEFAULT_VRC_JUMP };
  const ledgeY = GROUND + 0.35;
  let t = 0;
  for (; t < 300; t += 20) {
    predictor.setInput({ t, move: [0, 0], turn: 0, headYawRate: 0, jump: false });
    predictor.add({
      t,
      pose: { source: "petplay-origin-v2", position: [0, GROUND, 0], yawRad: 0 },
    });
  }
  const start = t;
  // Jump up and land on ledgeY; once on the ledge, VRChat stops sending Y updates.
  const samples = jumpSamples(start, 2.9, 9.6).filter(([ts, y]) =>
    ts - start < 300 || y >= ledgeY
  );
  // Final sample lands on the ledge.
  const landT = samples[samples.length - 1][0] + 20;
  samples.push([landT, ledgeY]);

  let i = 0;
  let maxDropBelowLedge = 0;
  for (; t < start + 1000; t += 10) {
    predictor.setInput({
      t,
      move: [0, 0],
      turn: 0,
      headYawRate: 0,
      jump: t < start + 100,
    });
    while (i < samples.length && samples[i][0] <= t) {
      predictor.add({
        t: samples[i][0],
        pose: { source: "petplay-origin-v2", position: [0, samples[i][1], 0], yawRad: 0 },
      });
      i++;
    }
    const y = predictor.display(t).pose.position[1];
    if (t >= landT) {
      maxDropBelowLedge = Math.max(maxDropBelowLedge, ledgeY - y);
    }
  }
  assert(
    maxDropBelowLedge < 0.08,
    `plunged ${(maxDropBelowLedge * 100).toFixed(1)} cm below ledge`,
  );
  assert(!predictor.jump.active, "jump arc should have ended on the ledge");
  assertEquals(predictor.jump.params.jumps, 0, "ledge landing should not pollute jump learning");
});
