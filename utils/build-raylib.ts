import { fromFileUrl, resolve } from "@std/path";
import { type NativeBuildTarget, nativeBuildTarget } from "../classes/nativeBuildTarget.ts";

const root = new URL("../", import.meta.url);
const sourceUrl = "https://codeload.github.com/raysan5/raylib/tar.gz/refs/tags/5.5";
const sourceSha256 = "aea98ecf5bc5c5e0b789a76de0083a21a70457050ea4cc2aec7566935f5e258e";
export const RAYLIB_ZIG_VERSION = "0.13.0";

async function run(command: string, args: string[], cwd?: string): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`${command} failed (${result.code})`);
}

/** Build the official 5.5 recipe with our small external-GLFW patch. */
export async function buildRaylib(target: NativeBuildTarget, sysroot?: string): Promise<string> {
  if (!target.endsWith("linux-gnu")) throw new Error("This raylib recipe targets Linux only");
  const output = fromFileUrl(new URL(`dist/native/${target}/libraylib.so`, root));
  if (
    Deno.env.get("PETPLAY_PREBUILT_RAYLIB") === "1" &&
    await Deno.stat(output).then(() => true, () => false)
  ) {
    console.log(`Reusing ${output}`);
    return output;
  }
  if (target !== nativeBuildTarget() && !sysroot) {
    throw new Error("Cross-building raylib requires --sysroot=<target root with libglfw.so>");
  }
  const zig = Deno.env.get("PETPLAY_ZIG") ?? "zig";
  const version = await new Deno.Command(zig, { args: ["version"] }).output();
  if (!version.success || new TextDecoder().decode(version.stdout).trim() !== RAYLIB_ZIG_VERSION) {
    throw new Error(
      `raylib 5.5 requires pinned Zig ${RAYLIB_ZIG_VERSION}; set PETPLAY_ZIG to its executable`,
    );
  }
  const work = fromFileUrl(new URL(`dist/raylib-build/${target}/`, root));
  await Deno.mkdir(work, { recursive: true });
  const archive = `${work}/raylib-5.5.tar.gz`;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await Deno.readFile(archive);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`raylib download failed: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sha !== sourceSha256) throw new Error(`raylib source SHA-256 mismatch: ${sha}`);
  await Deno.writeFile(archive, bytes);
  // Re-extract the verified original before patching; repeated builds cannot apply the patch twice.
  await run("tar", ["-xf", archive, "-C", work]);
  const source = `${work}/raylib-5.5`;
  await run("patch", [
    "--batch",
    "-p1",
    "-i",
    fromFileUrl(new URL("utils/native/raylib/external-glfw.patch", root)),
  ], source);
  const prefix = `${work}/install`;
  const architecture = target.split("-")[0];
  await run(zig, [
    "build",
    `-Dtarget=${architecture}-linux-gnu`,
    "-Doptimize=ReleaseFast",
    "-Dshared=true",
    "-Dexternal_glfw=true",
    "-Dopengl_version=gl_4_3",
    "--prefix",
    prefix,
    ...(sysroot ? [`-Dtarget_sysroot=${resolve(sysroot)}`] : []),
  ], source);
  await Deno.mkdir(fromFileUrl(new URL(`dist/native/${target}/`, root)), { recursive: true });
  await Deno.copyFile(`${prefix}/lib/libraylib.so`, output);
  console.log(`Built ${output}`);
  return output;
}

if (import.meta.main) {
  const target = Deno.args.find((a) => a.startsWith("--target="))?.slice(9);
  const sysroot = Deno.args.find((a) => a.startsWith("--sysroot="))?.slice(10);
  if (
    Deno.args.some((a) => !a.startsWith("--target=") && !a.startsWith("--sysroot=")) ||
    Deno.args.length !== Number(target !== undefined) + Number(sysroot !== undefined)
  ) {
    throw new Error(
      "usage: deno task build:raylib [--target=<Rust target>] [--sysroot=<target root>]",
    );
  }
  await buildRaylib(nativeBuildTarget(target), sysroot);
}
