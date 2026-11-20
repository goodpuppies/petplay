/** Native helpers the rdp actors run. Each can be overridden by env, for tests and builds. */
import { fromFileUrl } from "@std/path";
import { nativeBuildTarget, screenStreamerRelativePath } from "../classes/nativeBuildTarget.ts";

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** `screen-streamer`: PETPLAY_SCREEN_STREAMER, else the submodule's release build, else dist. */
export function screenStreamerPath(): string {
  const override = Deno.env.get("PETPLAY_SCREEN_STREAMER");
  if (override) return override;
  const built = fromFileUrl(
    new URL("../submodules/screen-streamer/target/release/screen-streamer", import.meta.url),
  );
  if (exists(built)) return built;
  return fromFileUrl(
    new URL(`../${screenStreamerRelativePath(nativeBuildTarget())}`, import.meta.url),
  );
}
