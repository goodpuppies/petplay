import { assertEquals } from "@std/assert";
import type { ToastInput } from "./toastStore.ts";
import {
  startXsoNotificationReceiver,
  toastFromXsoApiMessage,
  toastFromXsoNotification,
} from "./xsoNotificationReceiver.ts";

Deno.test("legacy XSO datagrams become toasts", () => {
  assertEquals(
    toastFromXsoNotification({
      messageType: 1,
      title: "Heart rate",
      content: "142 bpm",
      timeout: 2.5,
      sourceApp: "HRM",
      icon: "warning",
    }),
    { title: "Heart rate", content: "142 bpm", source: "HRM", timeoutMs: 2500, tone: "warning" },
  );
  assertEquals(toastFromXsoNotification({ messageType: 2, title: "Now playing" }), null);
  assertEquals(toastFromXsoNotification({ messageType: 1 }), null);
  assertEquals(toastFromXsoNotification("nope"), null);
  // Content-only toasts promote the content to the title.
  assertEquals(toastFromXsoNotification({ content: "hi" })?.title, "hi");
});

Deno.test("XSO WebSocket API SendNotification becomes a toast", () => {
  const toast = toastFromXsoApiMessage({
    sender: "ChatRelay",
    target: "xsoverlay",
    command: "SendNotification",
    jsonData: JSON.stringify({ title: "Message", content: "hello", icon: "error" }),
  });
  assertEquals(toast?.source, "ChatRelay");
  assertEquals(toast?.tone, "error");
  assertEquals(toastFromXsoApiMessage({ command: "SetTheme", jsonData: "{}" }), null);
  assertEquals(toastFromXsoApiMessage({ command: "SendNotification", jsonData: "{bad" }), null);
});

Deno.test("receiver accepts both wire formats over localhost", async () => {
  const received: ToastInput[] = [];
  let resolveCount: () => void = () => {};
  const both = new Promise<void>((resolve) => resolveCount = resolve);
  const receiver = startXsoNotificationReceiver({
    udpPort: 42169,
    wsPort: 42170,
    onToast: (toast) => {
      received.push(toast);
      if (received.length === 2) resolveCount();
    },
    log: () => {},
  });
  assertEquals([receiver.udp, receiver.ws], [true, true]);

  const udp = Deno.listenDatagram({ transport: "udp", hostname: "127.0.0.1", port: 0 });
  await udp.send(
    new TextEncoder().encode(JSON.stringify({ messageType: 1, title: "udp" })),
    { transport: "udp", hostname: "127.0.0.1", port: 42169 },
  );
  const ws = new WebSocket("ws://127.0.0.1:42170/?client=test");
  await new Promise((resolve) => ws.onopen = resolve);
  ws.send(JSON.stringify({ command: "SendNotification", jsonData: '{"title":"ws"}' }));

  await both;
  assertEquals(received.map((t) => t.title).sort(), ["udp", "ws"]);

  ws.close();
  await new Promise((resolve) => ws.onclose = resolve);
  udp.close();
  receiver.close();
});

Deno.test("a busy port is skipped, not fatal", () => {
  const holder = Deno.listenDatagram({ transport: "udp", hostname: "127.0.0.1", port: 42171 });
  const logs: string[] = [];
  const receiver = startXsoNotificationReceiver({
    udpPort: 42171,
    wsPort: 42172,
    log: (m) => logs.push(m),
  });
  assertEquals([receiver.udp, receiver.ws], [false, true]);
  assertEquals(logs.length, 1);
  receiver.close();
  holder.close();
});
