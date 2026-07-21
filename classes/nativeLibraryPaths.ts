import { fromFileUrl } from "@std/path";

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Continue through platform/runtime-specific candidates.
    }
  }
  return null;
}

export function getOpenVrLibraryPath(base: string | URL = import.meta.url): string {
  const override = Deno.env.get("PETPLAY_OPENVR_LIBRARY");
  if (override) return override;
  if (Deno.build.os === "windows") {
    return fromFileUrl(new URL("../resources/openvr_api.dll", base));
  }
  return firstExisting([
    "/usr/lib/libopenvr_api.so",
    `${
      Deno.env.get("HOME") ?? ""
    }/.local/share/Steam/steamapps/common/SteamVR/bin/linux64/libopenvr_api.so`,
  ]) ?? "libopenvr_api.so";
}

export function getRaylibLibraryPath(base: string | URL = import.meta.url): string {
  const override = Deno.env.get("PETPLAY_RAYLIB_LIBRARY");
  if (override) return override;
  if (Deno.build.os === "windows") {
    return fromFileUrl(new URL("../resources/raylib.dll", base));
  }
  return firstExisting([
    fromFileUrl(new URL("../resources/libraylib.so", base)),
    "/usr/lib/libraylib.so",
    "/usr/local/lib/libraylib.so",
  ]) ?? "libraylib.so";
}
