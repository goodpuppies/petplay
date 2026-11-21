export const NATIVE_BUILD_TARGETS = [
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;

export type NativeBuildTarget = typeof NATIVE_BUILD_TARGETS[number];

export function nativeBuildTarget(target?: string): NativeBuildTarget {
  if (!target && Deno.build.os !== "linux" && Deno.build.os !== "windows") {
    throw new Error(`Unsupported native build platform: ${Deno.build.os}`);
  }
  const resolved = target ??
    (Deno.build.os === "windows"
      ? `${Deno.build.arch}-pc-windows-msvc`
      : `${Deno.build.arch}-unknown-linux-gnu`);
  if (!NATIVE_BUILD_TARGETS.includes(resolved as NativeBuildTarget)) {
    throw new Error(`Unsupported native build target: ${resolved}`);
  }
  return resolved as NativeBuildTarget;
}

export function screenStreamerRelativePath(target: NativeBuildTarget): string {
  return `dist/native/${target}/screen-streamer${target.includes("windows") ? ".exe" : ""}`;
}

export function petplayMediaRelativePath(target: NativeBuildTarget): string {
  return `dist/native/${target}/petplay-media${target.includes("windows") ? ".exe" : ""}`;
}
