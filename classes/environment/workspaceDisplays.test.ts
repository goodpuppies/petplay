import { workspaceOutputsFromKscreen } from "./workspaceDisplays.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, received ${a}`);
}

Deno.test("KDE outputs become normalized Full Workspace crops", () => {
  const outputs = workspaceOutputsFromKscreen({
    outputs: [
      {
        id: 2,
        name: "wide",
        enabled: true,
        connected: true,
        priority: 1,
        pos: { x: 0, y: 0 },
        size: { width: 3440, height: 1440 },
        scale: 1,
        rotation: 1,
      },
      {
        id: 1,
        name: "side",
        enabled: true,
        connected: true,
        priority: 2,
        pos: { x: 3440, y: 180 },
        size: { width: 1920, height: 1080 },
        scale: 1,
        rotation: 1,
      },
    ],
  });
  assertEquals(outputs.map((output) => output.name), ["side", "wide"]);
  assertEquals(outputs[0]?.crop, {
    x: 3440 / 5360,
    y: 180 / 1440,
    width: 1920 / 5360,
    height: 0.75,
  });
  assertEquals(outputs[1]?.crop, { x: 0, y: 0, width: 3440 / 5360, height: 1 });
});

Deno.test("disabled outputs do not occupy workspace extent", () => {
  const outputs = workspaceOutputsFromKscreen({
    outputs: [
      {
        id: 1,
        enabled: true,
        connected: true,
        pos: { x: -1920, y: 0 },
        size: { width: 1920, height: 1080 },
        scale: 1,
      },
      {
        id: 2,
        enabled: false,
        connected: true,
        pos: { x: 0, y: 0 },
        size: { width: 3840, height: 2160 },
        scale: 1,
      },
    ],
  });
  assertEquals(outputs[0]?.crop, { x: 0, y: 0, width: 1, height: 1 });
});
