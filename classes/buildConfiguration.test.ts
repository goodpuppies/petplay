import { assertEquals, assertThrows } from "@std/assert";
import { parseBuildConfiguration } from "./buildConfiguration.ts";
Deno.test("build variants select explicit production/development conditions and distinct default artifacts", () => {
  const prod = parseBuildConfiguration([]), dev = parseBuildConfiguration(["--mode=development"]);
  assertEquals([prod.envFile, prod.output], ["release.env", "dist/petplay"]);
  assertEquals([dev.envFile, dev.output], ["development.env", "dist/petplay-debug"]);
  assertEquals(
    parseBuildConfiguration(["--output=_scratch/exact-app"]).output,
    "_scratch/exact-app",
  );
  assertEquals(
    parseBuildConfiguration(["--target=aarch64-unknown-linux-gnu"]).output,
    "dist/petplay-aarch64",
  );
});
Deno.test("ambiguous build configuration is rejected before compiling a benchmark artifact", () => {
  for (
    const args of [["--mode=debug"], ["--mode=production", "--mode=development"], ["--output="], [
      "--target=bogus",
    ], ["--unknown=yes"]]
  ) assertThrows(() => parseBuildConfiguration(args));
});
