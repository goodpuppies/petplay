/**
 * Packs `unity/PetPlayOrigin/` into a standard `.unitypackage` archive
 * (`dist/PetPlay-VRCOrigin.unitypackage`), without requiring Unity on the build host.
 *
 * A `.unitypackage` is a gzipped POSIX USTAR tar archive containing, for each asset:
 *   `<guid>/pathname`   — Unity project-relative path (e.g. `Assets/PetPlay/Origin/PetPlayOrigin.prefab`)
 *   `<guid>/asset.meta` — exact `.meta` file contents
 *   `<guid>/asset`      — exact asset file bytes (omitted for folder entries)
 *
 * Usage:
 *   deno task build:unity-origin
 *   deno run -A utils/build-unity-origin-package.ts [--out=<path>]
 */

import { join, relative } from "node:path";

export const DEFAULT_SOURCE_DIR = "unity/PetPlayOrigin";
export const DEFAULT_UNITY_ROOT = "Assets/PetPlay/Origin";
export const DEFAULT_OUT_PATH = "dist/PetPlay-VRCOrigin.unitypackage";

const EXCLUDED_TOP_LEVEL = new Set(["Editor", "README.md"]);

export interface UnityPackageEntry {
  guid: string;
  unityPath: string;
  metaBytes: Uint8Array;
  assetBytes: Uint8Array | null;
}

export function parseGuidFromMeta(metaText: string, metaPath: string): string {
  const match = metaText.match(/^guid:\s*([0-9a-fA-F]{32})\s*$/m);
  if (!match) {
    throw new Error(`No 32-hex Unity guid found in ${metaPath}`);
  }
  return match[1].toLowerCase();
}

export async function collectUnityPackageEntries(
  sourceDir: string,
  unityRoot = DEFAULT_UNITY_ROOT,
): Promise<UnityPackageEntry[]> {
  const entries: UnityPackageEntry[] = [];
  const seenGuids = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    const dirEntries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) {
      dirEntries.push(entry);
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".meta")) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(sourceDir, fullPath).replaceAll("\\", "/");
      const topSegment = relPath.split("/")[0];
      if (EXCLUDED_TOP_LEVEL.has(topSegment)) continue;

      const metaPath = `${fullPath}.meta`;
      let metaBytes: Uint8Array;
      try {
        metaBytes = await Deno.readFile(metaPath);
      } catch {
        throw new Error(`Missing Unity .meta file for ${fullPath}`);
      }

      const metaText = new TextDecoder().decode(metaBytes);
      const guid = parseGuidFromMeta(metaText, metaPath);
      const unityPath = `${unityRoot}/${relPath}`;

      const prev = seenGuids.get(guid);
      if (prev) {
        throw new Error(`Duplicate Unity guid ${guid} in ${prev} and ${unityPath}`);
      }
      seenGuids.set(guid, unityPath);

      if (entry.isDirectory) {
        entries.push({ guid, unityPath, metaBytes, assetBytes: null });
        await walk(fullPath);
      } else if (entry.isFile) {
        const assetBytes = await Deno.readFile(fullPath);
        entries.push({ guid, unityPath, metaBytes, assetBytes });
      }
    }
  }

  await walk(sourceDir);
  entries.sort((a, b) => a.unityPath.localeCompare(b.unityPath));
  return entries;
}

export interface TarEntry {
  name: string;
  data: Uint8Array;
  type?: "file" | "directory";
}

export function buildTarArchive(files: ReadonlyArray<TarEntry>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (const file of files) {
    const isDir = file.type === "directory";
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(file.name);
    if (nameBytes.length > 100) {
      throw new Error(`Tar entry name exceeds 100 bytes: ${file.name}`);
    }
    header.set(nameBytes, 0);
    // mode: 0000777\0 (matches Unity's own ExportPackage tar entries)
    header.set(encoder.encode("0000777\0"), 100);
    // uid, gid: 0000000\0
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    // size in 11 octal digits + \0
    const dataLen = isDir ? 0 : file.data.length;
    const sizeOctal = dataLen.toString(8).padStart(11, "0") + "\0";
    header.set(encoder.encode(sizeOctal), 124);
    // mtime: fixed 0 for reproducible builds
    header.set(encoder.encode("00000000000\0"), 136);
    // checksum placeholder: 8 spaces
    header.fill(0x20, 148, 156);
    // typeflag: '5' (directory) or '0' (regular file)
    header[156] = isDir ? 0x35 : 0x30;
    // magic: "ustar\0" + version "00"
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);

    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
    header.set(encoder.encode(checksumOctal), 148);

    chunks.push(header);
    totalLength += 512;

    if (!isDir && file.data.length > 0) {
      chunks.push(file.data);
      totalLength += file.data.length;
      const pad = (512 - (file.data.length % 512)) % 512;
      if (pad > 0) {
        chunks.push(new Uint8Array(pad));
        totalLength += pad;
      }
    }
  }

  // Two 512-byte zero blocks mark end-of-archive.
  const eof = new Uint8Array(1024);
  chunks.push(eof);
  totalLength += 1024;

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(new Uint8Array(input)).then(() => writer.close());
  const outChunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    outChunks.push(value);
  }
  await writePromise;

  let len = 0;
  for (const c of outChunks) len += c.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of outChunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function buildUnityPackageBytes(
  sourceDir = DEFAULT_SOURCE_DIR,
  unityRoot = DEFAULT_UNITY_ROOT,
): Promise<{ bytes: Uint8Array; entries: UnityPackageEntry[] }> {
  const entries = await collectUnityPackageEntries(sourceDir, unityRoot);
  if (entries.length === 0) {
    throw new Error(`No Unity assets found in ${sourceDir}`);
  }
  const encoder = new TextEncoder();
  const empty = new Uint8Array(0);
  const tarFiles: TarEntry[] = [];
  for (const entry of entries) {
    // Unity's ImportPackage requires the `<guid>/` directory entry before its children.
    tarFiles.push({ name: `${entry.guid}/`, data: empty, type: "directory" });
    if (entry.assetBytes !== null) {
      tarFiles.push({ name: `${entry.guid}/asset`, data: entry.assetBytes });
    }
    tarFiles.push({ name: `${entry.guid}/asset.meta`, data: entry.metaBytes });
    tarFiles.push({ name: `${entry.guid}/pathname`, data: encoder.encode(entry.unityPath) });
  }
  const tarBytes = buildTarArchive(tarFiles);
  const gzBytes = await gzipBytes(tarBytes);
  return { bytes: gzBytes, entries };
}

if (import.meta.main) {
  let outPath = DEFAULT_OUT_PATH;
  let sourceDir = DEFAULT_SOURCE_DIR;
  for (const arg of Deno.args) {
    if (arg.startsWith("--out=")) outPath = arg.slice("--out=".length);
    else if (arg.startsWith("--source=")) sourceDir = arg.slice("--source=".length);
  }
  const { bytes, entries } = await buildUnityPackageBytes(sourceDir);
  const outDir = outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".";
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeFile(outPath, bytes);
  console.log(
    `Packed ${entries.length} Unity assets (${bytes.length} bytes) -> ${outPath}`,
  );
}
