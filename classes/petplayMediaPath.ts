/**
 * Where `petplay-media` is: `PETPLAY_LINK_BINARY` / `PETPLAY_MEDIA_BINARY`; else, in a source
 * checkout, the built binary in `dist/native/...` or `submodules/petplay_mediatransport/target/`;
 * else the binary embedded in a compiled PetPlay release, extracted once to `tempDir()`.
 */
import { fromFileUrl, join } from "@std/path";
import { tempDir } from "./appPaths.ts";
import { nativeBuildTarget, petplayMediaRelativePath } from "./nativeBuildTarget.ts";

export const PETPLAY_MEDIA_PROCESS_NAME = Deno.build.os === "windows"
  ? "petplay-media.exe"
  : "petplay-media";

let extractedPath: string | null = null;

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function sourceCheckoutCandidates(forLink: boolean): string[] {
  if (Deno.build.standalone) return [];
  const exe = Deno.build.os === "windows" ? ".exe" : "";
  const rels = [
    petplayMediaRelativePath(nativeBuildTarget()),
    ...(forLink ? [`submodules/petplay_mediatransport/target/link/release/petplay-media${exe}`] : []),
    `submodules/petplay_mediatransport/target/release/petplay-media${exe}`,
  ];
  const paths: string[] = [];
  for (const rel of rels) {
    const url = new URL(`../${rel}`, import.meta.url);
    if (url.protocol === "file:") {
      paths.push(fromFileUrl(url));
    }
  }
  return paths;
}

/** Resolves `petplay-media` (extracting from the compiled bundle if needed). */
export function petplayMediaPath(options?: { forLink?: boolean }): string {
  const forLink = options?.forLink === true;
  if (forLink) {
    const linkOverride = Deno.env.get("PETPLAY_LINK_BINARY");
    if (linkOverride) return linkOverride;
  }
  const mediaOverride = Deno.env.get("PETPLAY_MEDIA_BINARY");
  if (mediaOverride) return mediaOverride;

  for (const candidate of sourceCheckoutCandidates(forLink)) {
    if (isFile(candidate)) return candidate;
  }

  if (extractedPath && isFile(extractedPath)) return extractedPath;

  const url = new URL(`../${petplayMediaRelativePath(nativeBuildTarget())}`, import.meta.url);
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(url);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      "petplay-media is missing. Run deno task build:native, or set PETPLAY_MEDIA_BINARY / PETPLAY_LINK_BINARY.",
    );
  }
  const runtimeDir = tempDir();
  Deno.mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, PETPLAY_MEDIA_PROCESS_NAME);
  // Avoid ETXTBSY if another worker already extracted and launched the identical binary.
  let sameSize = false;
  try {
    sameSize = Deno.statSync(path).size === bytes.byteLength;
  } catch {
    sameSize = false;
  }
  if (!sameSize) {
    const staged = `${path}.${Deno.pid}.new`;
    Deno.writeFileSync(staged, bytes);
    if (Deno.build.os !== "windows") Deno.chmodSync(staged, 0o755);
    Deno.renameSync(staged, path);
  }
  return extractedPath = path;
}

/** True when a usable `petplay-media` binary is available on disk or embedded. */
export function hasPetplayMediaBinary(options?: { forLink?: boolean }): boolean {
  try {
    return isFile(petplayMediaPath(options));
  } catch {
    return false;
  }
}
