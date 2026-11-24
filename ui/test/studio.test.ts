/**
 * End-to-end test for the PetPlay UI web preview studio:
 * boots `ui/studio.tsx` via `PostalService`, connects a WebSocket tab client, verifies raythree
 * `SceneStore` deltas + camera arrive for the default Wrist Menu scene, and switches scenes.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { type ActorId, PostalService } from "../../submodules/stageforge/mod.ts";
import { decodeDelta, SceneStore, type TextRunData } from "../../submodules/raythree/src/store/mod.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => T, ok: (v: T) => boolean, what: string): Promise<T> {
  const until = Date.now() + 20_000;
  let value = read();
  while (!ok(value)) {
    if (Date.now() > until) throw new Error(`${what}: last ${JSON.stringify(value)}`);
    await sleep(50);
    value = read();
  }
  return value;
}

function collectTexts(store: SceneStore): string[] {
  const texts: string[] = [];
  for (const id of store.ids("items")) {
    const row = store.get("items", id);
    const header = row?.header as { kind?: string } | undefined;
    if (header?.kind === "textRun") {
      const data = row?.data as TextRunData | undefined;
      if (data?.text) texts.push(data.text);
    }
  }
  return texts;
}

function countUiQuads(store: SceneStore): number {
  let count = 0;
  for (const id of store.ids("items")) {
    const row = store.get("items", id);
    const header = row?.header as { kind?: string } | undefined;
    if (header?.kind === "uiQuad") count++;
  }
  return count;
}

Deno.test({
  name: "ui studio streams raythree IR deltas to a tab and switches scenes",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    PostalService.actors.clear();
    const postal = new PostalService();
    const preview = await postal.add("../preview.ts", import.meta.url);
    let studio: ActorId | null = null;
    let ws: WebSocket | null = null;
    try {
      const started = await postal.PostMessage({
        target: preview,
        type: "START",
        payload: { hostname: "127.0.0.1", port: 0, watch: false },
      }, true) as { url: string; actors: { studio: ActorId } };
      const { url } = started;
      studio = started.actors.studio;

      const replica = new SceneStore();
      let camera: { projection: number[]; world: number[] } | null = null;
      let deltas = 0;

      const wsUrl = url.replace(/^http:/, "ws:") + "tab";
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve();
        ws!.onerror = (e) => reject(e);
      });

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const delta = decodeDelta(new Uint8Array(event.data));
          replica.apply(delta);
          deltas++;
          ws!.send(JSON.stringify({ ack: delta.toTick }));
        } else if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.camera) camera = msg.camera;
        }
      };

      ws.send(JSON.stringify({ viewport: { width: 1280, height: 800, dpr: 1 } }));

      const initialTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("PetPlay UI") && texts.includes("Wrist Menu"),
        "studio toolbar and wrist menu arrive in scene store",
      );
      assert(deltas > 0, "received at least one raythree delta");
      assert(camera !== null, "received orthographic camera");
      assert(countUiQuads(replica) > 10, "received UI quads for toolbar and wrist menu");
      assert(initialTexts.includes("Design System"), "scene tabs present");

      // Switch to Settings window scene.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "settings" }, true);
      const settingsTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("Controller Lasers") && texts.includes("Haptic Feedback"),
        "settings window scene renders after switch",
      );
      assert(settingsTexts.includes("Wrist"));

      // Switch to Display Menu scene.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "display" }, true);
      const displayTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("Screen (1:1)") && texts.includes("DP-1"),
        "display menu scene renders after switch",
      );
      assert(displayTexts.includes("Side:"));

      // Switch to Recursive Grid lab scene.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "grid" }, true);
      const gridTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("Guides: Off") && texts.includes("Row 4: Context 4x1"),
        "recursive grid scene renders after switch",
      );
      assert(gridTexts.includes("Reset Sandbox"));

      // Switch scene to Design System and verify tokens specimen arrives.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "design" }, true);
      const designTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("COLOR TOKENS") && texts.includes("OUTLINE"),
        "design system scene renders after switch",
      );
      assert(designTexts.includes("ICONS (MSDF ATLAS)"));

      // Switch to Keyboard scene.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "keyboard" }, true);
      const kbTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("Locale:") && texts.includes("Clear"),
        "keyboard scene renders after switch",
      );
      assert(kbTexts.includes("Mode:"));

      // Switch to Toasts & Bar scene.
      await postal.PostMessage({ target: studio, type: "SETSCENE", payload: "toasts" }, true);
      const toastTexts = await eventually(
        () => collectTexts(replica),
        (texts) => texts.includes("+ INFO") && texts.includes("Layout 1 loaded"),
        "toasts scene renders after switch",
      );
      assert(toastTexts.includes("+ ERROR"));

      const health = await postal.PostMessage({ target: studio, type: "__HEALTH__", payload: null }, true) as {
        tabConnected: boolean;
        scene: string;
        lastError: string | null;
      };
      assertEquals(health.tabConnected, true);
      assertEquals(health.scene, "toasts");
      assertEquals(health.lastError, null);

      // Hot reload: snapshot -> shutdown -> respawn -> restore on the same port & scene.
      await postal.PostMessage({ target: preview, type: "RELOAD", payload: null }, true);
      const afterReload = new SceneStore();
      const ws2 = new WebSocket(wsUrl);
      ws2.binaryType = "arraybuffer";
      ws = ws2;
      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => resolve();
        ws2.onerror = (e) => reject(e);
      });
      ws2.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const delta = decodeDelta(new Uint8Array(event.data));
          afterReload.apply(delta);
          ws2.send(JSON.stringify({ ack: delta.toTick }));
        }
      };
      ws2.send(JSON.stringify({ viewport: { width: 1280, height: 800, dpr: 1 } }));
      const restoredTexts = await eventually(
        () => collectTexts(afterReload),
        (texts) => texts.includes("PetPlay UI") && texts.includes("+ INFO"),
        "restored studio serves the same scene after RELOAD",
      );
      assert(restoredTexts.includes("Layout 1 loaded"));
    } finally {
      ws?.close();
      for (const id of [studio, preview]) {
        if (!id) continue;
        await postal.shutdown(id, { bestEffort: true });
      }
      PostalService.actors.clear();
    }
  },
});
