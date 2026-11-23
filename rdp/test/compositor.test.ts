import { assertEquals, assertExists } from "jsr:@std/assert";
import { createActorId, PostalService } from "../../submodules/stageforge/mod.ts";
import { mapWindowPointer } from "../inputRouter.ts";
import type { CompositorSnapshot } from "../compositor.tsx";

const SECRET = "0123456789abcdef0123456789abcdef";

Deno.test("mapWindowPointer maps window-local coords through region and trims titlebar", () => {
  const mapped = mapWindowPointer({
    inputActor: createActorId(`desktopInput@${crypto.randomUUID()}`),
    local: true,
    region: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 },
    // Window geometry is 1000x500, stream client area is 1000x450 -> 50px (10%) titlebar at top.
    windowSize: { width: 1000, height: 500 },
    feedSize: { width: 1000, height: 450 },
    event: { t: "pointer", x: 0.5, y: 0 },
  });
  assertEquals(mapped.t, "pointer");
  if (mapped.t === "pointer") {
    assertEquals(Math.round(mapped.x * 1000) / 1000, 0.45);
    // y=0 on client area should land at 0.1 + 0.1 * 0.5 = 0.15
    assertEquals(Math.round(mapped.y * 1000) / 1000, 0.15);
  }
});

Deno.test("mediaMux + inputRouter + compositor: wallpaper, windows, FEED_ENDED, and snapshot", async () => {
  const postal = new PostalService();
  try {
    const srcDesktop = await postal.add("./fakeMuxSource.ts", import.meta.url);
    const srcVrchat = await postal.add("./fakeMuxSource.ts", import.meta.url);
    const mux = await postal.add("../mediaMux.ts", import.meta.url);
    const router = await postal.add("../inputRouter.ts", import.meta.url);
    const comp = await postal.add("../compositor.tsx", import.meta.url);

    await postal.PostMessage({
      target: srcDesktop,
      type: "CONFIGURE",
      payload: { machine: "cachyos", kind: "desktop", input: null },
    }, true);
    await postal.PostMessage({
      target: srcVrchat,
      type: "CONFIGURE",
      payload: { machine: "homepc · VRChat", kind: "vrchat", input: null },
    }, true);

    await postal.PostMessage({
      target: mux,
      type: "START",
      payload: {
        secret: SECRET,
        localSources: [
          { actor: srcDesktop, kind: "desktop", machine: "cachyos", guarded: false },
          { actor: srcVrchat, kind: "vrchat", machine: "homepc · VRChat", guarded: false },
        ],
      },
    }, true);
    await postal.PostMessage({ target: router, type: "START", payload: {} }, true);
    await postal.PostMessage({
      target: comp,
      type: "START",
      payload: {
        secret: SECRET,
        mediaMux: mux,
        inputRouter: router,
        webtransport: false,
      },
    }, true);

    // Wait briefly for auto-wallpaper to acquire VRChat feed.
    await new Promise((r) => setTimeout(r, 80));

    // Open a window on cachyos.
    const windows = await postal.PostMessage({
      target: mux,
      type: "LISTWINDOWS",
      payload: { source: srcDesktop },
    }, true) as Array<{ id: string; title: string; app: string; width: number; height: number }>;
    assertEquals(windows.length, 1);

    const opened = await postal.PostMessage({
      target: comp,
      type: "OPEN_WINDOW",
      payload: { source: srcDesktop, window: windows[0] },
    }, true) as { id: string; feedId: string };
    assertExists(opened.id);
    assertExists(opened.feedId);

    // Move, mute, and snapshot compositor state.
    await postal.PostMessage({
      target: comp,
      type: "MOVE_WINDOW",
      payload: { id: opened.id, x: 120, y: 80, width: 640, height: 420 },
    }, true);
    await postal.PostMessage({
      target: comp,
      type: "MUTE_WINDOW",
      payload: { id: opened.id, muted: true },
    }, true);

    const snap = await postal.PostMessage({
      target: comp,
      type: "__SNAPSHOT__",
      payload: null,
    }, true) as CompositorSnapshot;
    assertEquals(snap.windows.length, 1);
    assertEquals(snap.windows[0]!.x, 120);
    assertEquals(snap.windows[0]!.muted, true);
    assertEquals(snap.wallpaper?.label, "homepc · VRChat");

    // Simulate the remote window closing -> desktopSource pushes FEED_ENDED -> mediaMux -> compositor drops it.
    await postal.PostMessage({
      target: srcDesktop,
      type: "SIMULATE_WINDOW_CLOSE",
      payload: { window: "win-1" },
    }, true);
    await new Promise((r) => setTimeout(r, 80));

    const after = await postal.PostMessage({
      target: comp,
      type: "GET_STATE",
      payload: null,
    }, true) as { windows: unknown[]; wallpaper: { label: string } | null };
    assertEquals(after.windows.length, 0);
    assertEquals(after.wallpaper?.label, "homepc · VRChat");

    // Restore snapshot -> window state comes back cleanly.
    await postal.PostMessage({
      target: comp,
      type: "__RESTORE__",
      payload: snap,
    }, true);
    const restored = await postal.PostMessage({
      target: comp,
      type: "GET_STATE",
      payload: null,
    }, true) as { windows: Array<{ x: number; muted: boolean }> };
    assertEquals(restored.windows.length, 1);
    assertEquals(restored.windows[0]!.x, 120);
    assertEquals(restored.windows[0]!.muted, true);

    // Full StageForge hot-reload (`postal.reload`) keeps ActorId, windows, wallpaper, and mediaMux.
    const reloadedInfo = await postal.reload(comp);
    assertEquals(reloadedInfo.reloadCount, 1);
    const afterReload = await postal.PostMessage({
      target: comp,
      type: "GET_STATE",
      payload: null,
    }, true) as { windows: Array<{ x: number; muted: boolean }>; wallpaper: { label: string } | null };
    assertEquals(afterReload.windows.length, 1);
    assertEquals(afterReload.windows[0]!.x, 120);
    assertEquals(afterReload.wallpaper?.label, "homepc · VRChat");
  } finally {
    for (const id of [...PostalService.actors.keys()].reverse()) {
      await postal.PostMessage({ target: id, type: "SHUTDOWN", payload: null }, true).catch(
        () => {},
      );
    }
  }
});
