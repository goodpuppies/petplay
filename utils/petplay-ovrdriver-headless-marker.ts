/** Bounded moving-overlay control; refuses anything except the synthetic panel lab. */
import * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { stringToPointer } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { getOpenVrLibraryPath } from "../classes/nativeLibraryPaths.ts";
const seconds = Number(Deno.args.find((arg) => arg.startsWith("--seconds="))?.slice(10) ?? 8);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
  throw Error("Marker duration must be 0..600 seconds");
}
const settings = JSON.parse(
  await Deno.readTextFile(`${Deno.env.get("HOME")}/.local/share/Steam/config/steamvr.vrsettings`),
);
if (
  settings.steamvr?.forcedDriver !== "petplay" || !settings.driver_petplay?.syntheticHmd ||
  !settings.driver_petplay?.virtualDisplay
) throw Error("Refusing non-headless lab session");
if (!VR.initializeOpenVR(getOpenVrLibraryPath())) throw Error("No OpenVR");
const err = new Int32Array(1), ep = Deno.UnsafePointer.of(err) as VR.InitErrorPTRType;
VR.VR_InitInternal(ep, VR.ApplicationType.VRApplication_Overlay);
if (err[0]) throw Error(`init ${err[0]}`);
let overlay: VR.IVROverlay | undefined, handle = 0n;
function ok(n: number, what: string) {
  if (n) throw Error(`${what}: ${n}`);
}
try {
  const ptr = VR.VR_GetGenericInterface(stringToPointer(VR.IVROverlay_Version), ep);
  if (!ptr || err[0]) throw Error("No overlay interface");
  overlay = new VR.IVROverlay(ptr);
  const out = new BigUint64Array(1);
  ok(
    overlay.CreateOverlay(
      `petplay.headless.marker.${Deno.pid}`,
      "Headless moving marker",
      Deno.UnsafePointer.of(out),
    ),
    "create",
  );
  handle = out[0];
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255;
    pixels[i + 3] = 255;
  }
  ok(overlay.SetOverlayRaw(handle, Deno.UnsafePointer.of(pixels), 32, 32, 4), "pixels");
  ok(overlay.SetOverlayWidthInMeters(handle, .3), "width");
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1]);
  ok(
    overlay.SetOverlayTransformTrackedDeviceRelative(
      handle,
      0,
      Deno.UnsafePointer.of(matrix) as Deno.PointerValue<VR.HmdMatrix34>,
    ),
    "position",
  );
  ok(overlay.ShowOverlay(handle), "show");
  console.log("MARKER_SHOWN");
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < seconds * 1000) {
    const t = (performance.now() - start) / 1000;
    matrix[3] = .45 * Math.sin(t * 2 * Math.PI / 2.4);
    ok(
      overlay.SetOverlayTransformTrackedDeviceRelative(
        handle,
        0,
        Deno.UnsafePointer.of(matrix) as Deno.PointerValue<VR.HmdMatrix34>,
      ),
      "move",
    );
    if (n++ % 30 === 0) console.log(JSON.stringify({ t, x: matrix[3] }));
    await new Promise((r) => setTimeout(r, 13));
  }
} finally {
  if (overlay && handle) overlay.DestroyOverlay(handle);
  VR.VR_ShutdownInternal();
}
