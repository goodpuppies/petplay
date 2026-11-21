import { fromFileUrl } from "@std/path";
import {
  type NativeBuildTarget,
  nativeBuildTarget,
  petplayMediaRelativePath,
  screenStreamerRelativePath,
} from "../classes/nativeBuildTarget.ts";

const root = new URL("../", import.meta.url);

export async function buildNative(target: NativeBuildTarget): Promise<string> {
  const filename = `screen-streamer${target.includes("windows") ? ".exe" : ""}`;
  const manifest = fromFileUrl(new URL("submodules/screen-streamer/Cargo.toml", root));
  const targetDirectory = fromFileUrl(new URL("dist/cargo/", root));
  const output = fromFileUrl(new URL(screenStreamerRelativePath(target), root));
  // Off Windows, a Windows helper is linked with mingw-w64: MSVC's linker only runs on Windows.
  const cargoTarget = target.includes("windows") && Deno.build.os !== "windows"
    ? "x86_64-pc-windows-gnu"
    : target;
  const built = `${targetDirectory}/${cargoTarget}/release/${filename}`;
  // CI restores `built` from a cache keyed on the screen-streamer commit and skips cargo.
  const prebuilt = Deno.env.get("PETPLAY_PREBUILT_CAPTURE_HELPER") === "1" &&
    await Deno.stat(built).then(() => true, () => false);
  if (prebuilt) console.log(`Reusing ${built}`);
  const result = prebuilt ? { success: true, code: 0 } : await new Deno.Command("cargo", {
    args: ["build", "--locked", "--release", "--manifest-path", manifest, "--target", cargoTarget],
    env: { CARGO_TARGET_DIR: targetDirectory },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`screen-streamer build failed (${result.code})`);
  await Deno.mkdir(fromFileUrl(new URL(`dist/native/${target}/`, root)), { recursive: true });
  // Install by rename: a running capture helper keeps its own copy, where writing into the
  // file it executes from fails ("text file busy") on Linux.
  const staged = `${output}.new`;
  await Deno.copyFile(built, staged);
  if (!target.includes("windows")) await Deno.chmod(staged, 0o755);
  await Deno.rename(staged, output);
  if (target === nativeBuildTarget()) {
    const probe = await new Deno.Command(output, { args: ["--version"] }).output();
    if (!probe.success || !new TextDecoder().decode(probe.stdout).startsWith("screen-streamer ")) {
      throw new Error("Built capture helper failed its startup probe");
    }
  }
  console.log(`Built ${output}`);
  return output;
}

export async function buildMedia(target: NativeBuildTarget): Promise<string> {
  const isWindows = target.includes("windows");
  const filename = `petplay-media${isWindows ? ".exe" : ""}`;
  const manifest = fromFileUrl(new URL("submodules/petplay_mediatransport/Cargo.toml", root));
  const targetDirectory = fromFileUrl(new URL("dist/cargo-media/", root));
  const output = fromFileUrl(new URL(petplayMediaRelativePath(target), root));
  // Off Windows, a Windows helper is linked with mingw-w64: MSVC's linker only runs on Windows.
  const cargoTarget = isWindows && Deno.build.os !== "windows"
    ? "x86_64-pc-windows-gnu"
    : target;
  const built = `${targetDirectory}/${cargoTarget}/release/${filename}`;
  const prebuilt = Deno.env.get("PETPLAY_PREBUILT_MEDIA_HELPER") === "1" &&
    await Deno.stat(built).then(() => true, () => false);
  if (prebuilt) console.log(`Reusing ${built}`);
  const featureArgs = isWindows
    ? ["--no-default-features", "--features", "decode-windows,capture-windows"]
    : ["--features", "decode"];
  const result = prebuilt ? { success: true, code: 0 } : await new Deno.Command("cargo", {
    args: [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      manifest,
      "--target",
      cargoTarget,
      ...featureArgs,
    ],
    env: { CARGO_TARGET_DIR: targetDirectory },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`petplay-media build failed (${result.code})`);
  await Deno.mkdir(fromFileUrl(new URL(`dist/native/${target}/`, root)), { recursive: true });
  const staged = `${output}.new`;
  await Deno.copyFile(built, staged);
  if (!isWindows) await Deno.chmod(staged, 0o755);
  await Deno.rename(staged, output);
  console.log(`Built ${output}`);
  return output;
}

if (import.meta.main) {
  if (Deno.args.length > 1 || (Deno.args.length === 1 && !Deno.args[0]!.startsWith("--target="))) {
    throw new Error("usage: deno task build:native [--target=<Rust target>]");
  }
  const target = nativeBuildTarget(Deno.args[0]?.slice("--target=".length));
  await buildNative(target);
  await buildMedia(target);
}
