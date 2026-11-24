import { assertEquals } from "@std/assert";
import {
  createNotificationSink,
  type DesktopNotification,
  parseNotifyLine,
  stripNotificationMarkup,
} from "./desktopNotifications.ts";
import type { Toast, ToastInput } from "./toastStore.ts";

const line = (data: unknown[], member = "Notify") =>
  JSON.stringify({
    type: "method_call",
    member,
    payload: { type: "susssasa{sv}i", data },
  });

Deno.test("parses a Notify call from busctl's JSON", () => {
  // Captured from `busctl --user monitor --json=short` on KDE.
  const parsed = parseNotifyLine(
    line([
      "petplay-test",
      0,
      "",
      "PetPlay hints",
      "<b>bold</b> &amp; more",
      [],
      { urgency: { type: "y", data: 2 }, transient: { type: "b", data: true } },
      1500,
    ]),
  );
  assertEquals(parsed, {
    app: "petplay-test",
    replacesId: 0,
    toast: {
      title: "PetPlay hints",
      content: "bold & more",
      source: "petplay-test",
      timeoutMs: 1500,
      tone: "warning",
    },
  });
});

Deno.test("skips other messages, junk, and empty notifications", () => {
  assertEquals(
    parseNotifyLine(line(["a", 0, "", "t", "b", [], {}, -1], "CloseNotification")),
    null,
  );
  assertEquals(parseNotifyLine("not json"), null);
  assertEquals(parseNotifyLine(line(["a", 0, "", " ", "", [], {}, -1])), null);
});

Deno.test("a body-only notification uses the body as its title, and -1 gets the default time", () => {
  const parsed = parseNotifyLine(line(["", 0, "", "", 'line one\nline "two"', [], {}, -1]));
  assertEquals(parsed?.app, "Desktop");
  assertEquals(parsed?.toast.title, 'line one\nline "two"');
  assertEquals(parsed?.toast.content, "");
  assertEquals(parsed?.toast.timeoutMs, 4000);
});

Deno.test("markup is stripped and entities decoded", () => {
  assertEquals(
    stripNotificationMarkup('<a href="x">link</a><br/>a &lt;b&gt; &#65;&#x42; &nbsp;'),
    "link\na <b> AB &nbsp;",
  );
});

Deno.test("an update replaces its toast instead of stacking, and the setting gates it", () => {
  const pushed: ToastInput[] = [];
  const dismissed: number[] = [];
  let enabled = true;
  const sink = createNotificationSink(
    (input) => {
      pushed.push(input);
      return { id: pushed.length } as Toast;
    },
    (id) => dismissed.push(id),
    () => enabled,
  );
  const notification = (replacesId: number, content: string): DesktopNotification => ({
    app: "dolphin",
    replacesId,
    toast: { title: "Copying", content },
  });
  sink(notification(0, "10%"));
  sink(notification(7, "50%"));
  assertEquals(dismissed, [1]);
  sink(notification(0, "a new copy"));
  assertEquals(dismissed, [1], "a fresh notification with the same title stacks");
  enabled = false;
  sink(notification(7, "90%"));
  assertEquals(pushed.length, 3);
});
