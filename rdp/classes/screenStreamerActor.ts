/**
 * Shared handle to this process's single `screen-streamer` StageForge native actor.
 *
 * All Linux capture (workspace, individual KDE monitors via `stream_output`, individual windows
 * via `stream_window`) and uinput injection share ONE `screen-streamer` subprocess managed by
 * `PostalService` (`CREATE_NATIVE` / `NativeStdioProxy`).
 */
import { type ActorId, PostMan, System } from "../../submodules/stageforge/mod.ts";
import { captureSessionEnvironment } from "../../classes/ScreenCapturer/captureSessionEnvironment.ts";
import { screenStreamerPath } from "../../classes/ScreenCapturer/screenStreamerPath.ts";

let cached: Promise<ActorId> | null = null;

export function linuxWaylandEnv(): Record<string, string> {
  const env = captureSessionEnvironment();
  if (!env.WAYLAND_DISPLAY && !Deno.env.get("WAYLAND_DISPLAY")) {
    const runtime = env.XDG_RUNTIME_DIR ?? Deno.env.get("XDG_RUNTIME_DIR") ??
      `/run/user/${Deno.uid()}`;
    try {
      for (const entry of Deno.readDirSync(runtime)) {
        if (/^wayland-\d+$/.test(entry.name)) {
          env.WAYLAND_DISPLAY = entry.name;
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  return env;
}

/** Find or spawn this process's single `screenStreamer@*` native actor via `System`. */
export function ensureScreenStreamer(): Promise<ActorId> {
  if (cached) return cached;
  cached = (async () => {
    const actors = await PostMan.PostMessage({
      target: System,
      type: "INSPECT",
      payload: null,
    }, true) as Array<{ actorId: ActorId }>;
    const existing = actors.find((a) => String(a.actorId).startsWith("screenStreamer@"));
    if (existing) return existing.actorId;
    return await PostMan.PostMessage({
      target: System,
      type: "CREATE_NATIVE",
      payload: {
        cmd: screenStreamerPath(),
        env: Deno.build.os === "linux" ? linuxWaylandEnv() : undefined,
      },
    }, true) as ActorId;
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

export function resetScreenStreamerCache(): void {
  cached = null;
}
