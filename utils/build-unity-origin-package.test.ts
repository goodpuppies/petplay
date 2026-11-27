import { assert, assertEquals } from "@std/assert";
import {
  buildUnityPackageBytes,
  DEFAULT_SOURCE_DIR,
  parseGuidFromMeta,
} from "./build-unity-origin-package.ts";

async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(new Uint8Array(input)).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writePromise;
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function readTarEntries(tar: Uint8Array): Map<string, Uint8Array> {
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = decoder.decode(header.subarray(0, 100));
    const name = rawName.replace(/\0.*$/, "");
    const rawSize = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(rawSize, 8);
    offset += 512;
    files.set(name, tar.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

Deno.test("parseGuidFromMeta extracts 32-hex guid", () => {
  const guid = parseGuidFromMeta(
    "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789ABCDEF\n",
    "test.meta",
  );
  assertEquals(guid, "0123456789abcdef0123456789abcdef");
});

Deno.test("buildUnityPackageBytes packs unity/PetPlayOrigin into a valid .unitypackage", async () => {
  const { bytes, entries } = await buildUnityPackageBytes(DEFAULT_SOURCE_DIR);
  assert(entries.length >= 5, `expected at least 5 entries, got ${entries.length}`);

  const paths = new Set(entries.map((e) => e.unityPath));
  assert(paths.has("Assets/PetPlay/Origin/PetPlayOrigin.prefab"));
  assert(paths.has("Assets/PetPlay/Origin/World.prefab"));
  assert(paths.has("Assets/PetPlay/Origin/Animations/PetPlayOrigin.controller"));
  assert(paths.has("Assets/PetPlay/Origin/Animations/PetPlayOriginLocalOn.anim"));
  assert(paths.has("Assets/PetPlay/Origin/Animations/PetPlayOriginLocalOff.anim"));
  assert(paths.has("Assets/PetPlay/Origin/V2/PetPlayOriginV2.prefab"));
  assert(paths.has("Assets/PetPlay/Origin/V2/World.prefab"));
  assert(paths.has("Assets/PetPlay/Origin/V2/Animations/PetPlayOriginV2.controller"));
  for (const p of paths) {
    assert(!p.includes("/Editor/"), `Editor script must not be packed: ${p}`);
  }

  const tar = await gunzipBytes(bytes);
  const files = readTarEntries(tar);
  for (const entry of entries) {
    assert(files.has(`${entry.guid}/`), `missing directory entry for ${entry.unityPath}`);
    const pathnameBytes = files.get(`${entry.guid}/pathname`);
    assert(pathnameBytes !== undefined, `missing pathname for ${entry.unityPath}`);
    assertEquals(new TextDecoder().decode(pathnameBytes), entry.unityPath);
    assert(files.has(`${entry.guid}/asset.meta`), `missing asset.meta for ${entry.unityPath}`);
    if (entry.assetBytes !== null) {
      assertEquals(files.get(`${entry.guid}/asset`)?.length, entry.assetBytes.length);
    }
  }
});
