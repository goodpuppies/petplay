import { assert, assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import * as THREE from "three";
import {
  parseXrMessage,
  projectionTangents,
  suggestProfile,
  XrDriverWriter,
  type XrFrameMessage,
} from "./xrClientBridge.ts";

const identity: [number, number, number, number] = [0, 0, 0, 1];
const frame = (sequence: number, extra: Partial<XrFrameMessage> = {}): XrFrameMessage =>
  parseXrMessage({
    version: 1,
    type: "xr-frame",
    sequence,
    head: { position: [0, 1.6, 0], rotation: identity },
    ...extra,
  }) as XrFrameMessage;

Deno.test("frame messages validate poses, inputs and unknown fields", () => {
  const ok = frame(1, {
    right: {
      pose: { position: [0.2, 1, -0.3], rotation: [0, 0, 0, 2] },
      input: { trigger: 1, grip: 0, joystick: [0, -1], joystickClick: false, a: true, b: false },
    },
  });
  assertEquals(ok.right!.pose!.rotation, [0, 0, 0, 1]);
  const menu = parseXrMessage({
    version: 1,
    type: "xr-frame",
    sequence: 2,
    left: {
      input: {
        trigger: 0,
        grip: 0,
        joystick: [0, 0],
        joystickClick: false,
        a: false,
        b: false,
        system: true,
      },
    },
  }) as XrFrameMessage;
  assertEquals(menu.left!.input!.system, true);
  for (
    const bad of [
      { head: { position: [0, 1], rotation: identity } },
      { head: { position: [0, 1, 0], rotation: [0, 0, 0, 0] } },
      { head: { position: [0, 1, 0], rotation: identity, extra: 1 } },
      { head: { position: [0, 1, 0], rotation: identity, velocity: [0, 0, 99] } },
      { head: { position: [0, Infinity, 0], rotation: identity } },
      {
        left: {
          input: {
            trigger: 2,
            grip: 0,
            joystick: [0, 0],
            joystickClick: false,
            a: false,
            b: false,
          },
        },
      },
      {
        left: {
          input: { trigger: 0, grip: 0, joystick: [0, 0], joystickClick: 1, a: false, b: false },
        },
      },
    ]
  ) {
    assertThrows(() => parseXrMessage({ version: 1, type: "xr-frame", sequence: 1, ...bad }));
  }
  assertThrows(() => parseXrMessage({ version: 2, type: "xr-frame", sequence: 1 }));
  assertThrows(() => parseXrMessage({ version: 1, type: "xr-frame", sequence: -1 }));
  assertThrows(() => parseXrMessage({ version: 1, type: "pointermove" }));
});

Deno.test("projection tangents recover an off-centre WebXR frustum", () => {
  // THREE builds the same column-major off-axis matrix WebXR reports.
  const near = 0.1;
  const m = new THREE.Matrix4().makePerspective(
    -1.3 * near,
    0.9 * near,
    1.1 * near,
    -1.4 * near,
    near,
    100,
  );
  const t = projectionTangents(m.elements);
  assertAlmostEquals(t.left, 1.3, 1e-9);
  assertAlmostEquals(t.right, 0.9, 1e-9);
  assertAlmostEquals(t.up, 1.1, 1e-9);
  assertAlmostEquals(t.down, 1.4, 1e-9);
});

Deno.test("suggested profile covers both eyes after mirroring and measures IPD", () => {
  const near = 0.1;
  const matrix = (l: number, r: number, u: number, d: number) =>
    new THREE.Matrix4().makePerspective(-l * near, r * near, u * near, -d * near, near, 100)
      .elements;
  const suggested = suggestProfile(parseXrMessage({
    version: 1,
    type: "xr-views",
    // Right eye slightly wider on its temporal side than the left eye's mirror image.
    views: [
      {
        eye: "left",
        projection: matrix(1.3, 0.9, 1.1, 1.4),
        position: [-0.032, 0, 0],
        rotation: identity,
      },
      {
        eye: "right",
        projection: matrix(0.95, 1.35, 1.1, 1.4),
        position: [0.032, 0, 0],
        rotation: identity,
      },
    ],
    recommendedWidth: 1680,
    recommendedHeight: 1760,
  }) as never);
  assertEquals(suggested, {
    fovTanLeft: 1.35,
    fovTanRight: 0.95,
    fovTanUp: 1.1,
    fovTanDown: 1.4,
    ipdMeters: 0.064,
    renderWidth: 1680,
    renderHeight: 1760,
  });
});

Deno.test("driver writer keeps only the latest pose per device and sends inputs on change", async () => {
  const sent: [string, unknown][] = [];
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => unblock = resolve);
  const writer = new XrDriverWriter(async (type, payload) => {
    sent.push([type, payload]);
    if (sent.length === 1) await gate;
  });
  const input = {
    trigger: 0.5,
    grip: 0,
    joystick: [0, 0],
    joystickClick: false,
    a: false,
    b: false,
  };
  const first = writer.apply(frame(1));
  // While the first head pose is in flight, three more frames arrive.
  writer.apply(frame(2, { head: { position: [0, 1.61, 0], rotation: identity } }));
  writer.apply(
    frame(3, { head: { position: [0, 1.62, 0], rotation: identity }, left: { input } as never }),
  );
  writer.apply(
    frame(4, { head: { position: [0, 1.63, 0], rotation: identity }, left: { input } as never }),
  );
  unblock();
  await first;
  assertEquals(sent.map(([type]) => type), ["SETHMDPOSE", "SETHMDPOSE", "SETCONTROLLERINPUT"]);
  assertEquals((sent[1][1] as { position: number[] }).position[1], 1.63);
  // Unchanged input is not resent.
  await writer.apply(frame(5, { left: { input } as never }));
  assertEquals(sent.filter(([type]) => type === "SETCONTROLLERINPUT").length, 1);
});

Deno.test("a failing device does not stall the head, and release clears everything", async () => {
  const sent: string[] = [];
  const writer = new XrDriverWriter((type, payload) => {
    sent.push(`${type}:${JSON.stringify(payload)}`);
    return type === "SETCONTROLLERPOSE" && !(payload as { clear?: boolean }).clear
      ? Promise.reject(Error("ControllersDisabled"))
      : Promise.resolve();
  });
  await writer.apply(frame(1, { right: { pose: { position: [0, 1, 0], rotation: identity } } }));
  await writer.apply(frame(2));
  assertEquals(writer.failures, 1);
  assert(writer.lastError?.includes("ControllersDisabled"));
  assertEquals(sent.filter((s) => s.startsWith("SETHMDPOSE")).length, 2);
  sent.length = 0;
  await writer.release();
  assert(sent.includes('SETHMDPOSE:{"clear":true}'));
  assert(sent.includes('SETCONTROLLERPOSE:{"hand":"left","clear":true}'));
  assert(sent.includes('SETCONTROLLERINPUT:{"hand":"right"}'));
});
