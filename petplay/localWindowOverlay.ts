/**
 * Single-process OpenVR + OpenGL overlay host for local window-backed `DisplayInstance`s.
 *
 * Spawned lazily by `petplay/localWindows.ts` when a user assigns a local window to a VR
 * display, and shared across all shown local windows (one GL context, one texture per active
 * window, one OpenVR overlay handle per display). Frames arrive from `screen-streamer` via
 * `desktopSource`'s `ADDWINDOWFRAMESINK` over local TCP (`FrameReceiver`).
 */
import * as gl from "https://deno.land/x/gluten@0.1.9/api/gl4.6.ts";
import { createWindow, type DwmWindow, getProcAddress } from "@gfx/dwm";
import { actorState, PostMan } from "../submodules/stageforge/mod.ts";
import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { P } from "../submodules/OpenVR_TS_Bindings_Deno/pointers.ts";
import { createStruct } from "../submodules/OpenVR_TS_Bindings_Deno/utils.ts";
import { OpenVrRuntime } from "../classes/openVrRuntime.ts";
import { withOverlayFlipY } from "../classes/overlayTextureFlip.ts";
import { setOverlayTransform } from "../classes/openvrTransform.ts";
import { FrameReceiver } from "../classes/ScreenCapturer/frameReceiver.ts";
import { type CapturedFrame, clampCaptureFps, DEFAULT_CAPTURE_FPS } from "../classes/ScreenCapturer/scclass.ts";
import { wait } from "../classes/utils.ts";

type WorkspaceCrop = { x: number; y: number; width: number; height: number };

type SyncVirtualDisplayPayload = {
  id: string;
  hmd: OpenVR.HmdMatrix34;
  widthMeters: number;
  crop: WorkspaceCrop;
  name?: string;
  opacity?: number;
  curvature?: number;
  deviceIndex?: number;
  rawUniverse?: boolean;
};

type WindowStream = {
  windowId: string;
  desktopSource: string;
  fps: number;
  receiver: FrameReceiver;
  textureId: number;
  textureView: DataView<ArrayBuffer>;
  width: number;
  height: number;
  frames: number;
  running: boolean;
  stopRequested: boolean;
  loop: Promise<void>;
};

type DisplayEntry = {
  id: string;
  windowId: string;
  handle: bigint;
  sync: SyncVirtualDisplayPayload | null;
  appliedWidth?: number;
  appliedAlpha?: number;
  appliedCurvature?: number;
  appliedCrop?: WorkspaceCrop;
  textureBound: boolean;
  visible: boolean;
};

const state = actorState({
  name: "localWindowOverlay",
  ready: false,
  windows: 0,
  displays: 0,
  lastError: null as string | null,
});

const openVrRuntime = new OpenVrRuntime("Local window overlay host OpenVR");
let overlayClass: OpenVR.IVROverlay | null = null;
let glWindow: DwmWindow | null = null;
let shuttingDown = false;

const windows = new Map<string, WindowStream>();
const displays = new Map<string, DisplayEntry>();
const displayToWindow = new Map<string, string>();
const pendingSyncs = new Map<string, SyncVirtualDisplayPayload>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REMOVAL_GRACE_MS = 250;

function syncUniverse(rawUniverse?: boolean): OpenVR.TrackingUniverseOrigin {
  return rawUniverse
    ? OpenVR.TrackingUniverseOrigin.TrackingUniverseRawAndUncalibrated
    : OpenVR.TrackingUniverseOrigin.TrackingUniverseStanding;
}

function textureBoundsForCrop(crop: WorkspaceCrop): OpenVR.TextureBounds {
  const x = Math.max(0, Math.min(1, crop.x));
  const y = Math.max(0, Math.min(1, crop.y));
  const width = Math.max(0, Math.min(1 - x, crop.width));
  const height = Math.max(0, Math.min(1 - y, crop.height));
  return { uMin: x, uMax: x + width, vMin: y + height, vMax: y };
}

function ensureRuntimeAndGl(): void {
  if (!overlayClass) {
    const pointers = openVrRuntime.initialize({
      overlay: "required",
      system: "optional",
      identity: {
        appKey: "petplay.local-window-overlay",
        name: "PetPlay Local Window Overlay",
      },
    });
    if (!pointers.overlay) throw new Error("Local window overlay IVROverlay unavailable");
    overlayClass = new OpenVR.IVROverlay(pointers.overlay);
  }
  if (!glWindow) {
    glWindow = createWindow({
      title: `PetPlayWindowOverlay_${Deno.pid}`,
      width: 1,
      height: 1,
      resizable: false,
      visible: false,
      glVersion: [3, 2],
      gles: false,
    });
    gl.load(getProcAddress);
  }
  state.ready = true;
}

function createGlTexture(): { id: number; view: DataView<ArrayBuffer> } {
  const tex = new Uint32Array(1);
  gl.GenTextures(1, tex);
  const id = tex[0];
  gl.BindTexture(gl.TEXTURE_2D, id);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.TexParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.BindTexture(gl.TEXTURE_2D, 0);
  const [, textureView] = createStruct<OpenVR.Texture>(
    {
      handle: BigInt(id) as unknown as Deno.PointerValue<unknown>,
      eType: OpenVR.TextureType.TextureType_OpenGL,
      eColorSpace: OpenVR.ColorSpace.ColorSpace_Auto,
    },
    OpenVR.TextureStruct,
  );
  return { id, view: textureView };
}

function uploadBgraTexture(
  stream: WindowStream,
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  gl.BindTexture(gl.TEXTURE_2D, stream.textureId);
  if (width !== stream.width || height !== stream.height) {
    gl.TexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.BGRA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    stream.width = width;
    stream.height = height;
  } else {
    gl.TexSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.BGRA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
  }
  gl.BindTexture(gl.TEXTURE_2D, 0);
}

function createOverlayHandle(displayId: string, name?: string): bigint {
  const overlay = overlayClass!;
  const key = `petplay.localWindowOverlay.${Deno.pid}.${displayId}`;
  const out = P.BigUint64P<OpenVR.OverlayHandle>();
  let err = overlay.CreateOverlay(key, name ?? displayId, out);
  if (err === OpenVR.OverlayError.VROverlayError_KeyInUse) {
    const findPtr = P.BigUint64P<OpenVR.OverlayHandle>();
    if (overlay.FindOverlay(key, findPtr) === OpenVR.OverlayError.VROverlayError_None) {
      const stale = new Deno.UnsafePointerView(findPtr).getBigUint64();
      overlay.HideOverlay(stale);
      overlay.DestroyOverlay(stale);
      err = overlay.CreateOverlay(key, name ?? displayId, out);
    }
  }
  if (err !== OpenVR.OverlayError.VROverlayError_None) {
    throw new Error(`CreateOverlay(${key}): ${OpenVR.OverlayError[err]}`);
  }
  const handle = new Deno.UnsafePointerView(out).getBigUint64();
  overlay.SetOverlayTexelAspect(handle, 1);
  return handle;
}

function cropEquals(a: WorkspaceCrop | undefined, b: WorkspaceCrop): boolean {
  return a != null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function applyDisplaySync(entry: DisplayEntry, sync: SyncVirtualDisplayPayload): void {
  const overlay = overlayClass;
  if (!overlay) return;
  entry.sync = sync;
  if (entry.appliedWidth !== sync.widthMeters) {
    overlay.SetOverlayWidthInMeters(entry.handle, sync.widthMeters);
    entry.appliedWidth = sync.widthMeters;
  }
  const alpha = sync.opacity ?? 1;
  if (entry.appliedAlpha !== alpha) {
    overlay.SetOverlayAlpha(entry.handle, Math.max(0, Math.min(1, alpha)));
    entry.appliedAlpha = alpha;
  }
  const curvature = sync.curvature ?? 0;
  if (entry.appliedCurvature !== curvature) {
    overlay.SetOverlayCurvature(entry.handle, Math.max(0, Math.min(1, curvature)));
    entry.appliedCurvature = curvature;
  }
  setOverlayTransform(
    overlay,
    entry.handle,
    sync.hmd,
    sync.deviceIndex,
    syncUniverse(sync.rawUniverse),
  );
  if (!cropEquals(entry.appliedCrop, sync.crop)) {
    const [boundsPtr] = createStruct<OpenVR.TextureBounds>(
      withOverlayFlipY(textureBoundsForCrop(sync.crop)),
      OpenVR.TextureBoundsStruct,
    );
    overlay.SetOverlayTextureBounds(entry.handle, boundsPtr);
    entry.appliedCrop = { ...sync.crop };
  }

  // Only bind the texture here on first attach; subsequent frame uploads bind in `pumpWindow`
  // so high-frequency drag pose syncs never force vrcompositor to re-import the GL texture.
  if (!entry.textureBound) {
    const stream = windows.get(entry.windowId);
    if (stream && stream.frames > 0) {
      const texPtr = Deno.UnsafePointer.of(stream.textureView.buffer) as Deno.PointerValue<
        OpenVR.Texture
      >;
      overlay.SetOverlayTexture(entry.handle, texPtr);
      entry.textureBound = true;
      if (!entry.visible) {
        overlay.ShowOverlay(entry.handle);
        entry.visible = true;
      }
    }
  }
}

function destroyDisplayEntry(displayId: string): void {
  const entry = displays.get(displayId);
  if (!entry) return;
  displays.delete(displayId);
  state.displays = displays.size;
  if (!overlayClass) return;
  try {
    overlayClass.HideOverlay(entry.handle);
    overlayClass.ClearOverlayTexture(entry.handle);
    overlayClass.DestroyOverlay(entry.handle);
  } catch {
    // Ignore teardown races.
  }
}

function syncDisplay(sync: SyncVirtualDisplayPayload): void {
  const timer = removalTimers.get(sync.id);
  if (timer != null) {
    clearTimeout(timer);
    removalTimers.delete(sync.id);
  }
  pendingSyncs.set(sync.id, sync);
  const windowId = displayToWindow.get(sync.id);
  if (!windowId || !overlayClass) return;

  let entry = displays.get(sync.id);
  if (entry && entry.windowId !== windowId) {
    entry.windowId = windowId;
    entry.textureBound = false;
    entry.visible = false;
    overlayClass.HideOverlay(entry.handle);
  }
  if (!entry) {
    const handle = createOverlayHandle(sync.id, sync.name);
    entry = {
      id: sync.id,
      windowId,
      handle,
      sync,
      textureBound: false,
      visible: false,
    };
    displays.set(sync.id, entry);
    state.displays = displays.size;
  }
  applyDisplaySync(entry, sync);
}

async function pumpWindow(stream: WindowStream): Promise<void> {
  let lastFrame: CapturedFrame | null = null;
  let nextPresentAt = 0;
  try {
    while (!stream.stopRequested && !shuttingDown) {
      const frame = await stream.receiver.nextFrame(lastFrame, 500);
      if (!frame) continue;
      const now = performance.now();
      if (now < nextPresentAt) {
        await wait(Math.max(1, nextPresentAt - now));
        continue;
      }
      lastFrame = frame;
      if (
        !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width <= 0 || frame.height <= 0 ||
        frame.data.byteLength < frame.width * frame.height * 4
      ) {
        continue;
      }
      uploadBgraTexture(stream, frame.data, frame.width, frame.height);
      stream.frames++;
      stream.running = true;
      const overlay = overlayClass;
      if (overlay) {
        const texPtr = Deno.UnsafePointer.of(stream.textureView.buffer) as Deno.PointerValue<
          OpenVR.Texture
        >;
        for (const entry of displays.values()) {
          if (entry.windowId !== stream.windowId) continue;
          overlay.SetOverlayTexture(entry.handle, texPtr);
          entry.textureBound = true;
          if (!entry.visible && entry.sync) {
            overlay.ShowOverlay(entry.handle);
            entry.visible = true;
          }
        }
      }
      nextPresentAt = performance.now() + 1000 / stream.fps;
    }
  } catch (error) {
    state.lastError = String(error instanceof Error ? error.message : error);
  } finally {
    stream.running = false;
  }
}

async function startWindow(
  windowId: string,
  desktopSource: string,
  fps?: number,
): Promise<{ running: boolean; frames: number; width: number; height: number }> {
  ensureRuntimeAndGl();
  const existing = windows.get(windowId);
  if (existing && !existing.stopRequested) {
    return {
      running: existing.running,
      frames: existing.frames,
      width: existing.width,
      height: existing.height,
    };
  }
  const receiver = await FrameReceiver.start();
  const { id: textureId, view: textureView } = createGlTexture();
  const clampedFps = clampCaptureFps(fps ?? DEFAULT_CAPTURE_FPS);
  try {
    await PostMan.PostMessage({
      target: desktopSource,
      type: "ADDWINDOWFRAMESINK",
      payload: { window: windowId, port: receiver.port, fps: clampedFps },
    }, true);
  } catch (error) {
    receiver.dispose();
    gl.DeleteTextures(1, new Uint32Array([textureId]));
    throw error;
  }
  const stream: WindowStream = {
    windowId,
    desktopSource,
    fps: clampedFps,
    receiver,
    textureId,
    textureView,
    width: 0,
    height: 0,
    frames: 0,
    running: false,
    stopRequested: false,
    loop: Promise.resolve(),
  };
  stream.loop = pumpWindow(stream);
  windows.set(windowId, stream);
  state.windows = windows.size;
  return { running: false, frames: 0, width: 0, height: 0 };
}

async function stopWindow(windowId: string): Promise<void> {
  const stream = windows.get(windowId);
  if (!stream) return;
  windows.delete(windowId);
  state.windows = windows.size;
  stream.stopRequested = true;
  for (const entry of displays.values()) {
    if (entry.windowId === windowId && overlayClass) {
      try {
        overlayClass.HideOverlay(entry.handle);
        overlayClass.ClearOverlayTexture(entry.handle);
      } catch { /* ignore */ }
      entry.textureBound = false;
      entry.visible = false;
    }
  }
  await Promise.race([
    PostMan.PostMessage({
      target: stream.desktopSource,
      type: "REMOVEWINDOWFRAMESINK",
      payload: { window: windowId },
    }, true).catch(() => {}),
    wait(2_000),
  ]);
  stream.receiver.dispose();
  await Promise.race([stream.loop, wait(1_000)]);
  if (overlayClass) {
    try {
      overlayClass.WaitFrameSync(50);
    } catch { /* ignore */ }
  }
  try {
    gl.DeleteTextures(1, new Uint32Array([stream.textureId]));
  } catch { /* ignore */ }
}

new PostMan(
  state,
  {
    __INIT__: () => {},
    __HEALTH__: () => ({ ...state }),
    STARTWINDOW: (payload: { windowId: string; desktopSource: string; fps?: number }) =>
      startWindow(payload.windowId, payload.desktopSource, payload.fps),
    STOPWINDOW: async (payload: { windowId: string }) => {
      await stopWindow(payload.windowId);
      return true;
    },
    ASSIGNDISPLAY: (payload: { displayId: string; windowId: string }) => {
      displayToWindow.set(payload.displayId, payload.windowId);
      const pending = pendingSyncs.get(payload.displayId);
      if (pending) syncDisplay(pending);
      return true;
    },
    UNASSIGNDISPLAY: (payload: { displayId: string }) => {
      displayToWindow.delete(payload.displayId);
      destroyDisplayEntry(payload.displayId);
      return true;
    },
    SYNCVIRTUALDISPLAY: (sync: SyncVirtualDisplayPayload) => {
      syncDisplay(sync);
    },
    REMOVEVIRTUALDISPLAY: (payload: { id: string }) => {
      pendingSyncs.delete(payload.id);
      const prev = removalTimers.get(payload.id);
      if (prev != null) clearTimeout(prev);
      const timer = setTimeout(() => {
        removalTimers.delete(payload.id);
        if (pendingSyncs.has(payload.id)) return;
        destroyDisplayEntry(payload.id);
      }, REMOVAL_GRACE_MS);
      removalTimers.set(payload.id, timer);
    },
    WINDOWSTATE: () => {
      const out: Record<string, { running: boolean; frames: number; width: number; height: number }> =
        {};
      for (const [id, stream] of windows) {
        out[id] = {
          running: stream.running,
          frames: stream.frames,
          width: stream.width,
          height: stream.height,
        };
      }
      return out;
    },
    __SHUTDOWN__: async () => {
      shuttingDown = true;
      for (const timer of removalTimers.values()) clearTimeout(timer);
      removalTimers.clear();
      for (const id of [...displays.keys()]) destroyDisplayEntry(id);
      for (const id of [...windows.keys()]) await stopWindow(id);
      if (glWindow) {
        try {
          glWindow.close();
        } catch { /* ignore */ }
        glWindow = null;
      }
      overlayClass = null;
      if (Deno.build.os === "linux") {
        openVrRuntime.deferReleaseToProcessExit();
      } else {
        openVrRuntime.shutdown();
      }
    },
  } as const,
);
