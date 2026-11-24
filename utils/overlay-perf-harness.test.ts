import { assertEquals, assertStrictEquals } from "@std/assert";
import { installSyntheticInput, type WebXrHostLike } from "./overlay-perf-harness.ts";

Deno.test("synthetic hands override live IVRInput and restore the original bridge", () => {
  const applied: unknown[] = [];
  const source = {
    inputReady: true,
    vrInput: {},
    leftBuffers: { joystick: new Float32Array(2) },
    rightBuffers: { joystick: new Float32Array(2) },
    leftView: { trigger: 0, grab: 0 },
    rightView: { trigger: 0, grab: 0 },
    update(_hmd: unknown, left: unknown, right: unknown) {
      applied.push([left, right]);
    },
  };
  const host = {
    directOpenVrInputSource: source,
    updateEmulatedControllersFromOpenVr() {
      assertStrictEquals(this.directOpenVrInputSource, source);
      applied.push([
        source.rightView.trigger,
        source.leftView.grab,
        source.rightBuffers.joystick[1],
      ]);
    },
  } as WebXrHostLike;
  const original = host.updateEmulatedControllersFromOpenVr;
  const input = installSyntheticInput(host);
  try {
    input.right.trigger = true;
    input.left.squeeze = true;
    input.right.joystickY = 0.5;
    host.updateEmulatedControllersFromOpenVr();
    assertEquals(applied.length, 2);
    assertEquals(applied[1], [1, 1, 0.5]);
    assertEquals(source.inputReady, true);
    // A real input poll can overwrite scalars between ticks; injection wins at the bridge.
    source.rightView.trigger = 0;
    host.updateEmulatedControllersFromOpenVr();
    assertEquals(applied[3], [1, 1, 0.5]);
  } finally {
    input.restore();
  }
  assertStrictEquals(host.updateEmulatedControllersFromOpenVr, original);
  source.rightView.trigger = 0;
  source.leftView.grab = 0;
  source.rightBuffers.joystick[1] = 0;
  host.updateEmulatedControllersFromOpenVr();
  assertEquals(applied[4], [0, 0, 0]);
});
