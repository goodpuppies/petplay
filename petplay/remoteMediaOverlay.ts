/** A process-owned remote desktop receiver: native GPU decode, GL import, OpenVR overlay. */
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as VR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { type GpuMediaFrame, GpuMediaSocket } from "../classes/gpuMediaSocket.ts";
import { EglMediaTexture } from "../classes/eglMediaTexture.ts";
import { RemoteDisplayBinding, type RemoteDisplaySync } from "../classes/remoteDisplayBinding.ts";
import { runWindowsMedia } from "./remoteMediaWindows.ts";
import { fromFileUrl } from "@std/path";
export type RemoteMediaRequest = {
  code?: string;
  url?: string;
  address?: string;
  widthMeters?: number;
  distance?: number;
  feedId?: string;
  name?: string;
};
const state = actorState({
  name: "remoteMedia",
  running: false,
  starting: false,
  lastError: null as string | null,
  frames: 0,
  feedId: "desktop",
  feedName: "Remote desktop",
  width: 0,
  height: 0,
});
const displayBinding = new RemoteDisplayBinding();
let stopRequested = false;
let task: Promise<void> | null = null;
new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    SYNCVIRTUALDISPLAY: (sync: RemoteDisplaySync) => displayBinding.sync(sync),
    REMOVEVIRTUALDISPLAY: (payload: { id: string }) => displayBinding.remove(payload.id),
    STARTMEDIA: (request: RemoteMediaRequest) => {
      if (task) throw Error("Remote media is already running");
      if (Deno.build.os !== "linux" && Deno.build.os !== "windows") {
        throw Error(
          "GPU remote media receiver is implemented on Linux and Windows",
        );
      }
      const width = request.widthMeters ?? 1.2, distance = request.distance ?? 1.5;
      if (
        !Number.isFinite(width) || width <= 0 || width > 10 || !Number.isFinite(distance) ||
        distance < .1 || distance > 20
      ) throw Error("Invalid overlay placement");
      if (!request.code && (!request.url || !request.address)) {
        throw Error(
          "A share code or iroh URL plus address is required",
        );
      }
      state.feedId = request.feedId?.trim().slice(0, 128) || "desktop";
      state.feedName = request.name?.trim().slice(0, 128) || "Remote desktop";
      stopRequested = false;
      state.starting = true;
      state.lastError = null;
      state.frames = 0;
      state.width = 0;
      state.height = 0;
      const receive = Deno.build.os === "windows"
        ? runWindowsMedia(request, width, distance, state, () => stopRequested, displayBinding)
        : run(request, width, distance);
      task = receive.catch((error) => {
        state.lastError = String(error);
        console.error("[remote-media]", error);
      }).finally(() => {
        state.running = false;
        state.starting = false;
        task = null;
      });
      return { starting: true };
    },
    STOPMEDIA: async () => {
      stopRequested = true;
      await task;
      return true;
    },
    __SHUTDOWN__: async () => {
      stopRequested = true;
      await task;
    },
  } as const,
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run(request: RemoteMediaRequest, width: number, distance: number) {
  const runtime = new OpenVrRuntime("remote-media");
  let importer: EglMediaTexture | undefined;
  let consumer: GpuMediaSocket | undefined;
  let native: Deno.ChildProcess | undefined;
  let nativeStatus: Deno.CommandStatus | undefined;
  let overlay: VR.IVROverlay | undefined;
  let handle = 0n;
  let directory: string | undefined;
  try {
    directory = await Deno.makeTempDir({
      dir: Deno.env.get("XDG_RUNTIME_DIR") ?? `/run/user/${Deno.uid()}`,
      prefix: "pp-media-",
    });
    const socket = `${directory}/frames.sock`;
    const binary = Deno.env.get("PETPLAY_MEDIA_BINARY") ??
      fromFileUrl(
        new URL(
          "../submodules/petplay_mediatransport/target/release/petplay-media",
          import.meta.url,
        ),
      );
    native = new Deno.Command(binary, {
      args: [
        "receive",
        ...(request.code ? [request.code] : [request.url!, request.address!]),
        socket,
      ],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    void native.status.then((status) => {
      nativeStatus = status;
    });
    const deadline = performance.now() + 15000;
    while (true) {
      try {
        if ((await Deno.stat(socket)).isSocket) break;
      } catch { /* receiver has not bound yet */ }
      if (stopRequested) return;
      if (nativeStatus) {
        throw Error(`Native receiver exited (${nativeStatus.code}); build with --features decode`);
      }
      if (performance.now() > deadline) throw Error("Native receiver startup failed");
      await sleep(25);
    }
    const pointers = runtime.initialize({
      overlay: "required",
      system: "required",
      compositor: false,
      input: false,
      renderModels: false,
      chaperoneSetup: false,
    });
    overlay = new VR.IVROverlay(pointers.overlay!);
    const out = new BigUint64Array(1);
    const ok = (error: number, what: string) => {
      if (error) throw Error(`${what}: ${VR.OverlayError[error]}`);
    };
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
    const system = new VR.IVRSystem(pointers.system!);
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
    const [, transformView] = createStruct({ m: rows } as VR.HmdMatrix34, VR.HmdMatrix34Struct);
    ok(
      overlay.SetOverlayTransformAbsolute(
        handle,
        VR.TrackingUniverseOrigin.TrackingUniverseStanding,
        Deno.UnsafePointer.of(transformView.buffer) as Deno.PointerValue<VR.HmdMatrix34>,
      ),
      "overlay placement",
    );
    displayBinding.attach(overlay, handle);
    importer = new EglMediaTexture();
    const texture = importer.texture;
    consumer = new GpuMediaSocket(socket);
    // Keep the backing buffer reachable, deriving its pointer on every submission.
    const [, textureView] = createStruct(
      {
        handle: BigInt(texture) as unknown as Deno.PointerValue,
        eType: VR.TextureType.TextureType_OpenGL,
        eColorSpace: VR.ColorSpace.ColorSpace_Auto,
      } as VR.Texture,
      VR.TextureStruct,
    );
    state.running = true;
    state.starting = false;
    let checkedAt = 0;
    while (!stopRequested) {
      if (nativeStatus) throw Error(`Native receiver exited (${nativeStatus.code})`);
      if (performance.now() - checkedAt > 250) {
        if (runtime.pollRuntimeEvents().exiting) break;
        checkedAt = performance.now();
      }
      let latest: GpuMediaFrame | null = null;
      for (;;) {
        const frame = consumer.poll();
        if (!frame) break;
        if (latest) consumer.release(latest);
        latest = frame;
      }
      if (latest) {
        importer.update(latest);
        consumer.release(latest);
        ok(
          overlay.SetOverlayTexture(
            handle,
            Deno.UnsafePointer.of(textureView.buffer) as Deno.PointerValue<VR.Texture>,
          ),
          "SetOverlayTexture",
        );
        displayBinding.presented();
        state.frames++;
        state.width = latest.width;
        state.height = latest.height;
      } else await sleep(5);
    }
  } finally {
    displayBinding.detach();
    if (overlay && handle) {
      overlay.HideOverlay(handle);
      overlay.ClearOverlayTexture(handle);
      overlay.DestroyOverlay(handle);
    }
    importer?.close();
    consumer?.close();
    runtime.shutdown();
    if (native) {
      await Promise.race([native.status, sleep(2000)]);
      if (!nativeStatus) {
        try {
          native.kill("SIGTERM");
        } catch { /* already ended */ }
        await native.status;
      }
    }
    if (directory) await Deno.remove(directory, { recursive: true }).catch(() => {});
  }
}
