/**
 * Where `screen-streamer` is: `PETPLAY_SCREEN_STREAMER`; else, in a checkout on Linux, the
 * submodule's release build when it exists; else the binary embedded in PetPlay
 * (`dist/native/...`), copied out under a stable name so a stale one can be found by name
 * (Windows) and executed (compiled builds).
 */
import { join } from "@std/path";
import { tempDir } from "../appPaths.ts";
import { nativeBuildTarget, screenStreamerRelativePath } from "../nativeBuildTarget.ts";

export const SCREEN_STREAMER_PROCESS_NAME = Deno.build.os === "windows"
  ? "petplay-screen-streamer.exe"
  : "petplay-screen-streamer";

let resolved: string | null = null;

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export function screenStreamerPath(): string {
  const override = Deno.env.get("PETPLAY_SCREEN_STREAMER");
  if (override) return override;
  if (resolved) return resolved;
  if (Deno.build.os === "linux") {
    const built = new URL(
      "../../submodules/screen-streamer/target/release/screen-streamer",
      import.meta.url,
    );
    if (built.protocol === "file:" && isFile(built.pathname)) return resolved = built.pathname;
  }
  const url = new URL(`../../${screenStreamerRelativePath(nativeBuildTarget())}`, import.meta.url);
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(url);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      "screen-streamer is missing. Run deno task build:native, or set PETPLAY_SCREEN_STREAMER.",
    );
  }
  const runtimeDir = tempDir();
  Deno.mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, SCREEN_STREAMER_PROCESS_NAME);
  Deno.writeFileSync(path, bytes);
  if (Deno.build.os !== "windows") Deno.chmodSync(path, 0o755);
  return resolved = path;
}

/**
 * A forced app exit can orphan the helper on Windows; remove only PetPlay's, by its stable name,
 * before starting a replacement.
 */
export async function stopStaleScreenStreamer(): Promise<void> {
  if (Deno.build.os !== "windows") return;
  try {
    await new Deno.Command("taskkill", {
      args: ["/F", "/IM", SCREEN_STREAMER_PROCESS_NAME],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Nothing to remove.
  }
}
