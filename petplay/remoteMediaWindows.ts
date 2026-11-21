/** Windows native receive helper. Stdio carries control and DXGI handles, never pixels. */
import * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { petplayMediaPath } from "../classes/petplayMediaPath.ts";
import type { RemoteDisplayBinding } from "../classes/remoteDisplayBinding.ts";
import type { RemoteMediaRequest } from "./remoteMediaOverlay.ts";
type State = { running: boolean; starting: boolean; frames: number; width: number; height: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function runWindowsMedia(
  request: RemoteMediaRequest,
  width: number,
  distance: number,
  state: State,
  stopping: () => boolean,
  displayBinding: RemoteDisplayBinding,
) {
  const runtime = new OpenVrRuntime("remote-media-windows");
  let overlay: VR.IVROverlay | undefined;
  let handle = 0n;
  let native: Deno.ChildProcess | undefined;
  let pump: Promise<void> | undefined;
  let streamError: unknown;
  let ended = false;
  let latest: { handle: string; width: number; height: number; sequence: number } | undefined;
  let status: Deno.CommandStatus | undefined;
  const ok = (error: number, what: string) => {
    if (error) throw Error(`${what}: ${VR.OverlayError[error]}`);
  };
  try {
    const pointers = runtime.initialize({
      overlay: "required",
      system: "required",
      compositor: false,
      input: false,
      renderModels: false,
      chaperoneSetup: false,
    });
    overlay = new VR.IVROverlay(pointers.overlay!);
    const system = new VR.IVRSystem(pointers.system!);
    const out = new BigUint64Array(1);
    ok(
      overlay.CreateOverlay(
        `petplay.remote-media.${Deno.pid}`,
        "PetPlay remote desktop",
        Deno.UnsafePointer.of(out),
      ),
      "CreateOverlay",
    );
    handle = out[0];
    ok(overlay.SetOverlayWidthInMeters(handle, width), "overlay width");
    const poses = new Uint8Array(
      VR.TrackedDevicePoseStruct.byteSize * VR.k_unMaxTrackedDeviceCount,
    );
    system.GetDeviceToAbsoluteTrackingPose(
      VR.TrackingUniverseOrigin.TrackingUniverseStanding,
      0,
      Deno.UnsafePointer.of(poses) as Deno.PointerValue<VR.TrackedDevicePose>,
      VR.k_unMaxTrackedDeviceCount,
    );
    const pose = VR.TrackedDevicePoseStruct.read(
      new DataView(poses.buffer),
    ) as unknown as VR.TrackedDevicePose;
    if (!pose.bPoseIsValid) throw Error("No valid headset pose for remote overlay placement");
    const rows = pose.mDeviceToAbsoluteTracking.m.map((row) => [...row]);
    for (let r = 0; r < 3; r++) rows[r][3] -= rows[r][2] * distance;
    const [, transform] = createStruct({ m: rows }, VR.HmdMatrix34Struct);
    ok(
      overlay.SetOverlayTransformAbsolute(
        handle,
        VR.TrackingUniverseOrigin.TrackingUniverseStanding,
        Deno.UnsafePointer.of(transform.buffer) as Deno.PointerValue<VR.HmdMatrix34>,
      ),
      "overlay placement",
    );
    displayBinding.attach(overlay, handle);
    // Keep decode on the same adapter SteamVR uses, including hybrid-GPU laptops.
    const adapter = new Int32Array(1);
    system.GetDXGIOutputInfo(Deno.UnsafePointer.of(adapter));
    const binary = petplayMediaPath();
    native = new Deno.Command(binary, {
      args: [
        "receive",
        ...(request.code ? [request.code] : [request.url!, request.address!]),
        "--stdio",
      ],
      env: { PETPLAY_DXGI_ADAPTER: String(adapter[0]) },
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    void native.status.then((s) => {
      status = s;
    });
    pump = (async () => {
      let pending = "";
      let sequence = 0;
      for await (const chunk of native!.stdout.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        for (;;) {
          const at = pending.indexOf("\n");
          if (at < 0) break;
          const line = pending.slice(0, at).trim();
          pending = pending.slice(at + 1);
          if (!line.startsWith("WINDOWS_MEDIA_FRAME ")) {
            console.log("[remote-media]", line);
            continue;
          }
          if (line.length > 4096) throw Error("Oversized native frame metadata");
          const frame = JSON.parse(line.slice(20));
          if (
            frame.version !== 1 || typeof frame.handle !== "string" ||
            !/^\d+$/.test(frame.handle) || BigInt(frame.handle) === 0n ||
            BigInt(frame.handle) > 0xffffffffffffffffn ||
            !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence ||
            !Number.isInteger(frame.width) ||
            !Number.isInteger(frame.height) || frame.width < 16 || frame.width > 8192 ||
            frame.height < 16 || frame.height > 8192
          ) throw Error("Invalid shared texture metadata");
          sequence = frame.sequence;
          latest = frame;
        }
        if (pending.length > 4096) throw Error("Oversized native metadata line");
      }
    })().catch((e) => {
      streamError = e;
    }).finally(() => {
      ended = true;
    });
    state.running = true;
    state.starting = false;
    let checkedAt = 0;
    let shared: string | undefined;
    while (!stopping()) {
      if (streamError) throw streamError;
      if (status || ended) {
        throw Error(`Native receiver exited (${status?.code ?? "stdout closed"})`);
      }
      if (performance.now() - checkedAt > 250) {
        if (runtime.pollRuntimeEvents().exiting) break;
        checkedAt = performance.now();
      }
      if (latest) {
        const frame = latest;
        latest = undefined;
        if (shared && frame.handle !== shared) {
          throw Error("Native shared texture changed during session");
        }
        shared = frame.handle;
        const [, texture] = createStruct({
          handle: BigInt(frame.handle),
          eType: VR.TextureType.TextureType_DXGISharedHandle,
          eColorSpace: VR.ColorSpace.ColorSpace_Auto,
        }, VR.TextureStruct);
        ok(
          overlay.SetOverlayTexture(
            handle,
            Deno.UnsafePointer.of(texture.buffer) as Deno.PointerValue<VR.Texture>,
          ),
          "SetOverlayTexture DXGI",
        );
        displayBinding.presented();
        state.frames++;
        state.width = frame.width;
        state.height = frame.height;
      } else await sleep(5);
    }
  } finally {
    displayBinding.detach();
    // Clear the compositor reference before asking the native owner to release the shared texture.
    if (overlay && handle) {
      overlay.HideOverlay(handle);
      overlay.ClearOverlayTexture(handle);
      overlay.DestroyOverlay(handle);
    }
    if (native) {
      try {
        const writer = native.stdin.getWriter();
        await writer.write(new TextEncoder().encode("STOP\n"));
        await writer.close();
      } catch { /* worker may already have ended */ }
      await Promise.race([native.status, sleep(2000)]);
      if (!status) {
        try {
          native.kill();
        } catch { /* exited */ }
        await native.status;
      }
      await pump;
    }
    runtime.shutdown();
  }
}
