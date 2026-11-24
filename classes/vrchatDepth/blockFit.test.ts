import { assertEquals } from "@std/assert";
import { deriveLayout } from "./format.ts";
import { cellPxFor, fitBlock, probeFit, windowScale } from "./blockFit.ts";
import { MODE_LAYOUT } from "./blockCalibration.ts";

const fits = (camera: { width: number; height: number }, scale: number, mode: "1d" | "3d") => {
  const fit = fitBlock(camera, scale, MODE_LAYOUT[mode]);
  const m = MODE_LAYOUT[mode];
  const layout = deriveLayout({
    bits: [m.bits, m.bits, m.bits],
    gridWidth: fit.gridWidth,
    depthWidth: fit.depthSize,
    depthHeight: fit.depthSize,
    calibration3D: m.calibration3D > 0,
    levelInset: m.levelInset,
  });
  return { fit, widthPx: fit.gridWidth * fit.cellPx, heightPx: layout.gridHeight * fit.cellPx };
};

Deno.test("the lab's 1:1 1920x1000 keeps today's layout in both modes", () => {
  for (const mode of ["1d", "3d"] as const) {
    assertEquals(fitBlock({ width: 1920, height: 1000 }, 1, MODE_LAYOUT[mode]), {
      cellPx: 1,
      gridWidth: 1024,
      depthSize: 512,
    });
  }
});

Deno.test("a resampled window gets cells of at least two window pixels", () => {
  assertEquals(cellPxFor(1), 1);
  assertEquals(cellPxFor(2.31), 1);
  assertEquals(cellPxFor(1.5), 2);
  assertEquals(cellPxFor(0.99), 3);
  assertEquals(cellPxFor(2 / 3), 3);
  assertEquals(cellPxFor(0.5), 4);
  assertEquals(cellPxFor(0.1), 9);
});

Deno.test("fitted blocks stay inside the camera image at any resolution", () => {
  for (const camera of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [1080, 1920]]) {
    for (const scale of [1, 0.75, 2 / 3, 0.5, 1.5]) {
      for (const mode of ["1d", "3d"] as const) {
        const [width, height] = camera;
        const { fit, widthPx, heightPx } = fits({ width, height }, scale, mode);
        if (widthPx > width - 16 || heightPx > height * 0.35 + 1e-9) {
          throw new Error(
            `${width}x${height} @${scale} ${mode}: ${
              JSON.stringify(fit)
            } is ${widthPx}x${heightPx}`,
          );
        }
        if (fit.cellPx * scale < 2 - 1e-9 && scale !== 1) {
          throw new Error(`cells too small: ${JSON.stringify(fit)}`);
        }
      }
    }
  }
});

Deno.test("a 1920x1080 camera in a 1280x720 window", () => {
  const scale = windowScale({ width: 1920, height: 1080 }, { width: 1280, height: 720 });
  const fit = fitBlock({ width: 1920, height: 1080 }, scale, MODE_LAYOUT["3d"]);
  assertEquals(fit.cellPx, 3);
  assertEquals(fit.gridWidth, 634);
  assertEquals(fit.depthSize >= 128, true);
});

Deno.test("probing walks from 1:1 to smaller windows", () => {
  const window = { width: 1280, height: 720 };
  assertEquals(probeFit(window, 0, MODE_LAYOUT["1d"]).cellPx, 1);
  assertEquals(probeFit(window, 1, MODE_LAYOUT["1d"]).cellPx, 3);
  assertEquals(probeFit(window, 2, MODE_LAYOUT["1d"]).cellPx, 4);
  assertEquals(probeFit(window, 3, MODE_LAYOUT["1d"]).cellPx, 7);
  assertEquals(probeFit(window, 4, MODE_LAYOUT["1d"]).cellPx, 1);
});
