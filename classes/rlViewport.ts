import { getRaylibLibraryPath } from "./nativeLibraryPaths.ts";

let rlgl:
  | Deno.DynamicLibrary<{
    rlViewport: { parameters: ["i32", "i32", "i32", "i32"]; result: "void" };
  }>
  | null = null;

/**
 * Restrict drawing to part of the bound render target (`glViewport`), for two eye images side by
 * side in one texture. `BeginTextureMode` sets the full target again; `BeginMode3D` leaves it.
 */
export function setRenderViewport(x: number, y: number, width: number, height: number): void {
  rlgl ??= Deno.dlopen(getRaylibLibraryPath(), {
    rlViewport: { parameters: ["i32", "i32", "i32", "i32"], result: "void" },
  });
  rlgl.symbols.rlViewport(x, y, width, height);
}
