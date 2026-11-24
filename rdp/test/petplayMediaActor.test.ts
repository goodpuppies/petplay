import { assertEquals, assertExists } from "@std/assert";
import { PostalService } from "../../submodules/stageforge/mod.ts";

Deno.test({
  name: "vrchatSource hosts its DMA-BUF socket feed via petplayMedia@* native actor",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const postal = new PostalService();
    const sock = `/tmp/test-petplay-media-actor-${crypto.randomUUID()}.sock`;
    try {
      const vrc = await postal.add("../vrchatSource.ts", import.meta.url);
      const port = 45000 + Math.floor(Math.random() * 10000);
      const info = await postal.PostMessage({
        target: vrc,
        type: "START",
        payload: { host: "127.0.0.1", port, socketPath: sock, layout: "mono", fps: 60 },
      }, true) as { host: string; port: number; fingerprint: string; webrtc?: boolean };
      assertEquals(info.host, "127.0.0.1");
      assertEquals(info.port, port);
      assertExists(info.fingerprint);
      assertEquals(info.webrtc, true);

      // Socket file was bound by petplay-media actor.
      Deno.statSync(sock);

      // petplayMedia@* native actor is registered in StageForge.
      const mediaEntry = [...PostalService.actors.entries()].find(([id]) =>
        String(id).startsWith("petplayMedia@")
      );
      assertExists(mediaEntry);
      const [mediaActorId, mediaActor] = mediaEntry;
      assertEquals(mediaActor.proxyTransport, "native-stdio");

      // LIST_FEEDS reports our active feed.
      const feeds = await postal.PostMessage({
        target: mediaActorId,
        type: "LIST_FEEDS",
        payload: null,
      }, true) as Array<{ id: string; connected: boolean; frames: number }>;
      assertEquals(feeds.length, 1);
      assertEquals(feeds[0]!.id, "vrchat");
      assertEquals(feeds[0]!.connected, false);
      assertEquals(feeds[0]!.frames, 0);

      // STOP cancels the feed and unlinks the socket cleanly.
      await postal.PostMessage({ target: vrc, type: "STOP", payload: null }, true);
      const feedsAfter = await postal.PostMessage({
        target: mediaActorId,
        type: "LIST_FEEDS",
        payload: null,
      }, true) as unknown[];
      assertEquals(feedsAfter.length, 0);

      let sockGone = false;
      try {
        Deno.statSync(sock);
      } catch {
        sockGone = true;
      }
      assertEquals(sockGone, true);

      // The same petplayMedia@* native actor also hosts GPU WindowAtlas feeds.
      const atlasPort = 46000 + Math.floor(Math.random() * 10000);
      const atlasInfo = await postal.PostMessage({
        target: mediaActorId,
        type: "ATLAS_START",
        payload: {
          id: "test-atlas",
          host: "127.0.0.1",
          port: atlasPort,
          width: 1280,
          height: 720,
          fps: 30,
        },
      }, true) as { id: string; host: string; port: number; fingerprint: string; webrtc?: boolean };
      assertEquals(atlasInfo.id, "test-atlas");
      assertEquals(atlasInfo.port, atlasPort);
      assertExists(atlasInfo.fingerprint);
      assertEquals(atlasInfo.webrtc, true);

      const withAtlas = await postal.PostMessage({
        target: mediaActorId,
        type: "LIST_FEEDS",
        payload: null,
      }, true) as Array<{ id: string; kind: string }>;
      assertEquals(withAtlas.length, 1);
      assertEquals(withAtlas[0]!.id, "test-atlas");
      assertEquals(withAtlas[0]!.kind, "atlas");

      await postal.PostMessage({
        target: mediaActorId,
        type: "STOP_FEED",
        payload: { id: "test-atlas" },
      }, true);
      const empty = await postal.PostMessage({
        target: mediaActorId,
        type: "LIST_FEEDS",
        payload: null,
      }, true) as unknown[];
      assertEquals(empty.length, 0);
    } finally {
      await postal.shutdownAll({ bestEffort: true });
      await Deno.remove(sock).catch(() => {});
    }
  },
});
