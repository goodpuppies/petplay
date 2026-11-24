import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  appConfigListsManifest,
  appConfigWithManifest,
  appConfigWithoutManifest,
  bashQuote,
  buildSteamVrLauncher,
  buildSteamVrManifest,
  STEAMVR_APP_KEY,
  vrAppConfigAutoLaunch,
  vrAppConfigWithAutoLaunch,
} from "./steamVrManifest.ts";

Deno.test("the manifest is a dashboard overlay with paths relative to itself", () => {
  const manifest = JSON.parse(buildSteamVrManifest({
    binaryPath: "launch-petplay.sh",
    imagePath: "petplay.png",
    os: "linux",
    arch: "x86_64",
  }));
  const [app] = manifest.applications;
  assertEquals(app.app_key, STEAMVR_APP_KEY);
  assertEquals(app.launch_type, "binary");
  assertEquals(app.binary_path_linux, "launch-petplay.sh");
  assertEquals(app.image_path, "petplay.png");
  assertEquals(app.is_dashboard_overlay, true);
  assertEquals(app.strings.en_us.name, "PetPlay");
});

Deno.test("the Steam Frame and Windows read their own binary field", () => {
  const arm = JSON.parse(buildSteamVrManifest({ binaryPath: "a", os: "linux", arch: "aarch64" }));
  assertEquals(arm.applications[0].binary_path_linux_arm, "a");
  assertFalse("binary_path_linux" in arm.applications[0]);
  const win = JSON.parse(buildSteamVrManifest({ binaryPath: "a.exe", os: "windows" }));
  assertEquals(win.applications[0].binary_path_windows, "a.exe");
});

Deno.test("bashQuote leaves plain paths alone and quotes the rest", () => {
  assertEquals(bashQuote("/home/u/.deno/bin/deno"), "/home/u/.deno/bin/deno");
  assertEquals(bashQuote("--keyboard-locale=fi"), "--keyboard-locale=fi");
  assertEquals(bashQuote("/a b/$x"), "'/a b/$x'");
  assertEquals(bashQuote("it's"), `'it'\\''s'`);
});

Deno.test("the launcher escapes the Steam runtime and runs the command in the checkout", () => {
  const script = buildSteamVrLauncher({
    workingDirectory: "/home/u/git/pet play",
    command: ["/usr/bin/deno", "run", "-A", "utils/steamvr-watch.ts", "--once"],
  });
  assert(script.startsWith("#!/usr/bin/env bash\n"));
  assert(script.includes("command=(/usr/bin/deno run -A utils/steamvr-watch.ts --once)"));
  assert(script.includes("steam-runtime-launch-client --alongside-steam"));
  assert(script.includes("--directory='/home/u/git/pet play'"));
  assert(script.includes("cd '/home/u/git/pet play'"));
});

Deno.test("the launcher is valid bash", async () => {
  const script = buildSteamVrLauncher({ workingDirectory: "/tmp/x y", command: ["echo", "it's"] });
  const { code } = await new Deno.Command("bash", { args: ["-n", "-c", script] }).output();
  assertEquals(code, 0);
});

Deno.test("appconfig keeps other apps' manifests and lists ours once", () => {
  const original = JSON.stringify({
    manifest_paths: ["/steam/steamapps.vrmanifest", "/wayvr/wayvr.vrmanifest"],
  });
  const added = appConfigWithManifest(original, "/p/petplay.vrmanifest");
  assertEquals(JSON.parse(added).manifest_paths, [
    "/steam/steamapps.vrmanifest",
    "/wayvr/wayvr.vrmanifest",
    "/p/petplay.vrmanifest",
  ]);
  assertEquals(appConfigWithManifest(added, "/p/petplay.vrmanifest"), added);
  assert(appConfigListsManifest(added, "/p/petplay.vrmanifest"));
  const removed = appConfigWithoutManifest(added, "/p/petplay.vrmanifest");
  assertEquals(JSON.parse(removed).manifest_paths, JSON.parse(original).manifest_paths);
  assertFalse(appConfigListsManifest(removed, "/p/petplay.vrmanifest"));
});

Deno.test("appconfig is created when SteamVR has never written one", () => {
  assertEquals(JSON.parse(appConfigWithManifest(null, "/p/m")).manifest_paths, ["/p/m"]);
});

Deno.test("vrappconfig toggles autolaunch and keeps SteamVR's other fields", () => {
  const on = vrAppConfigWithAutoLaunch(null, true);
  assert(vrAppConfigAutoLaunch(on));
  const seen = JSON.stringify({ autolaunch: true, last_launch_time: "1760000000" });
  const off = JSON.parse(vrAppConfigWithAutoLaunch(seen, false));
  assertEquals(off, { autolaunch: false, last_launch_time: "1760000000" });
  assertFalse(vrAppConfigAutoLaunch(null));
});
