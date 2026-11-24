import { assertAlmostEquals, assertEquals } from "@std/assert";
import { CaptureTiming } from "./captureTiming.ts";

const line = (n: number, pts = "1794071297.675792") =>
  `[Parsed_showinfo_0] n: ${n} pts:1794071297675792 pts_time:${pts} duration:16667\n`;

Deno.test("capture timing correlates split stderr lines and consumes only the requested frame", () => {
  const timing = new CaptureTiming();
  const text = line(0);
  timing.feed(text.slice(0, 40));
  assertEquals(timing.take(0), undefined);
  timing.feed(text.slice(40) + line(1));
  assertAlmostEquals(timing.take(0)!, 1794071297675.792, 0.001);
  assertEquals(timing.take(0), undefined);
  assertAlmostEquals(timing.take(1)!, 1794071297675.792, 0.001);
});

Deno.test("relative PTS and old unconsumed timestamps cannot pollute capture timings", () => {
  const timing = new CaptureTiming();
  timing.feed(line(0, "0.016667"));
  assertEquals(timing.take(0), undefined);
  for (let i = 1; i <= 200; i++) timing.feed(line(i));
  assertEquals(timing.take(1), undefined);
  assertEquals(typeof timing.take(200), "number");
});
