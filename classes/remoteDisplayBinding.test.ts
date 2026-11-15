import { RemoteDisplayBinding } from "./remoteDisplayBinding.ts";
import type * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
function fixture() {
  const calls: Array<[string, ...unknown[]]> = [];
  const api = new Proxy({}, {
    get: (_, name) => (...args: unknown[]) => {
      calls.push([String(name), ...args]);
      return 0;
    },
  }) as VR.IVROverlay;
  return { calls, api, binding: new RemoteDisplayBinding() };
}
const pose = { m: [[1, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, -2]] } as VR.HmdMatrix34;
const sync = (id: string) => ({
  id,
  hmd: pose,
  widthMeters: 1.4,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  opacity: .6,
  curvature: .2,
  rawUniverse: true,
});
function assert(value: unknown, message: string) {
  if (!value) throw Error(message);
}
Deno.test("remote feed becomes a managed display and follows pose/style updates", () => {
  const { api, calls, binding } = fixture();
  binding.attach(api, 1n);
  assert(!calls.length, "must wait for a texture");
  binding.presented();
  assert(calls.some((c) => c[0] === "ShowOverlay"), "standalone texture becomes visible");
  binding.sync(sync("display-3"));
  assert(calls.some((c) => c[0] === "SetOverlayAlpha" && c[2] === .6), "alpha not applied");
  assert(
    calls.some((c) => c[0] === "SetOverlayTransformAbsolute" && c[2] === 2),
    "raw tracking origin not applied",
  );
  binding.sync({ ...sync("display-3"), deviceIndex: 7 });
  assert(
    calls.some((c) => c[0] === "SetOverlayTransformTrackedDeviceRelative" && c[2] === 7),
    "controller carry not applied",
  );
  binding.detach();
});
Deno.test("old display cleanup cannot hide a reassigned feed", async () => {
  const { api, calls, binding } = fixture();
  binding.attach(api, 1n);
  binding.presented();
  binding.sync(sync("old"));
  binding.remove("old");
  binding.sync(sync("new"));
  await new Promise((r) => setTimeout(r, 270));
  assert(!calls.some((c) => c[0] === "HideOverlay"), "old cleanup hid new assignment");
  binding.remove("new");
  await new Promise((r) => setTimeout(r, 270));
  assert(calls.some((c) => c[0] === "HideOverlay"), "unassigned managed feed stayed visible");
  const shown = calls.filter((c) => c[0] === "ShowOverlay").length;
  binding.presented();
  assert(
    calls.filter((c) => c[0] === "ShowOverlay").length === shown,
    "incoming video redisplayed an unassigned feed",
  );
  binding.detach();
});
