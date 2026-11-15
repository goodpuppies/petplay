import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { LIGHTING } from "./format.ts";
import { LightVolumeCache, LV, volumeChecksum } from "./lightVolumes.ts";

import { nativeVolumePage, volumePage } from "./testdata/lightVolumeFixture.ts";

Deno.test("volume pages assemble out of order and publish only when every volume is complete", () => {
  const cache = new LightVolumeCache();
  for (let page = 31; page >= 0; page--) assert(cache.ingest(volumePage(page, 0, 2), 1000));
  assertEquals(cache.snapshot(1000), null);
  for (let page = 0; page < 32; page++) cache.ingest(volumePage(page, 1, 2), 1001);
  const s = cache.snapshot(1001)!;
  assertEquals(s.count, 2);
  assertEquals(s.volumes[0].coefficients[15 * 12], 1);
  const start = s.texture[51] * 4;
  assertEquals(Array.from(s.texture.slice(start, start + 4)), [Math.fround(0.1), 0, 0, 0]);
  assertEquals(s.texture[start + 15 * 12 + 3], 1);
  assertEquals(cache.snapshot(7000), null);
});

Deno.test("corrupt pages and replayed metadata cannot mix volume data", () => {
  const cache = new LightVolumeCache();
  const corrupt = volumePage(0);
  corrupt[LIGHTING.length + 70] = 99;
  assertEquals(cache.ingest(corrupt, 1000), false);
  assertEquals(cache.corrupt, 1);
  for (let p = 0; p < 32; p++) cache.ingest(volumePage(p), 1000);
  const original = cache.snapshot(1000)!;
  cache.ingest(volumePage(0), 1100);
  assertEquals(cache.snapshot(1100), original);
  const moved = volumePage(1);
  moved[LIGHTING.length + 15] = 10;
  const hash = volumeChecksum(moved.slice(LIGHTING.length, -2));
  moved[moved.length - 2] = hash & 65535;
  moved[moved.length - 1] = hash >>> 16;
  cache.ingest(moved, 1200);
  assertEquals(cache.snapshot(1200), null);
  assertEquals(original.volumes[0].metadata[3], 0);
});

Deno.test("old exporter records leave fallback intact and long gaps clear spatial assemblies", () => {
  const cache = new LightVolumeCache();
  assertEquals(cache.ingest(new Array(130).fill(0)), false);
  for (let p = 0; p < 32; p++) cache.ingest(volumePage(p), 1000);
  assert(cache.snapshot(1000));
  cache.ingest(volumePage(0), 20000);
  assertEquals(cache.snapshot(20000), null);
  assertEquals(cache.status(20000).complete, 0);
});

Deno.test("progressive refinement keeps coarse coverage until fine pages complete and never downgrades", () => {
  const cache = new LightVolumeCache();
  for (let id = 0; id < 2; id++) {
    for (let page = 0; page < 32; page++) cache.ingest(volumePage(page, id, 2), 1000);
  }
  const coarse = cache.snapshot(1000)!;
  assertEquals(coarse.volumes.map((v) => v.grid), [16, 16]);
  for (let page = 255; page > 0; page--) assert(cache.ingest(volumePage(page, 0, 2, 32), 2000));
  assertEquals(cache.snapshot(2000), coarse);
  assert(cache.ingest(volumePage(0, 0, 2, 32), 2000));
  const mixed = cache.snapshot(2000)!;
  assertEquals(mixed.volumes.map((v) => v.grid), [32, 16]);
  assertEquals(mixed.volumes[0].coefficients[31 * 12], 1);
  const texel0 = mixed.texture[51], texel1 = mixed.texture[64 + 51];
  assertEquals(texel1 - texel0, 32 ** 3 * 3);
  for (let page = 0; page < 32; page++) cache.ingest(volumePage(page, 0, 2), 3000);
  assertEquals(cache.snapshot(3000), mixed);
  assertEquals(cache.status(3000).refined, 1);
  // Long fine cycles still receive fresh packets; completed coarse data must stay usable.
  cache.ingest(volumePage(1, 1, 2, 32), 12000);
  cache.ingest(volumePage(2, 1, 2, 32), 22000);
  cache.ingest(volumePage(3, 1, 2, 32), 32000);
  assert(cache.snapshot(32000));
});

Deno.test("fine metadata changes invalidate old data and invalid fine page numbers are rejected", () => {
  const cache = new LightVolumeCache();
  for (let page = 0; page < 32; page++) cache.ingest(volumePage(page), 1000);
  const moved = volumePage(0, 0, 1, 32);
  moved[LIGHTING.length + 15] = 2;
  let h = volumeChecksum(moved.slice(LIGHTING.length, -2));
  moved[moved.length - 2] = h & 65535;
  moved[moved.length - 1] = h >>> 16;
  assert(cache.ingest(moved, 2000));
  assertEquals(cache.snapshot(2000), null);
  const invalid = volumePage(256, 0, 1, 32);
  assertEquals(cache.ingest(invalid, 2000), false);
});

Deno.test("native anisotropic texels preserve boundary mapping and partial final pages", () => {
  const cache = new LightVolumeCache(), dimensions: [number, number, number] = [34, 14, 22];
  const pages = Math.ceil(34 * 14 * 22 / 128);
  for (let p = pages - 1; p >= 0; p--) assert(cache.ingest(nativeVolumePage(p, dimensions), 1000));
  const s = cache.snapshot(1000)!;
  assertEquals(s.volumes[0].dimensions, dimensions);
  assertEquals(s.volumes[0].coefficients.length, 34 * 14 * 22 * 12);
  assertEquals(Array.from(s.texture.slice(52, 60)), [32, 12, 20, 1, .5, .5, .5, 0]);
  assertEquals(cache.status(1000).native, 1);
  assertEquals(cache.ingest(nativeVolumePage(pages, dimensions), 1000), false);
});

Deno.test("small native grids replace coarse grids regardless of axis size", () => {
  const cache = new LightVolumeCache();
  for (let p = 0; p < 32; p++) cache.ingest(volumePage(p), 1000);
  assert(cache.ingest(nativeVolumePage(0, [4, 3, 2]), 1001));
  assertEquals(cache.snapshot(1001)!.volumes[0].native, true);
  assertEquals(cache.snapshot(1001)!.volumes[0].dimensions, [4, 3, 2]);
});

Deno.test("legacy world version zero is preserved separately from transport version", () => {
  const cache = new LightVolumeCache();
  const record = nativeVolumePage(0, [4, 3, 2]), o = LIGHTING.length;
  record[o + 9] = 0;
  const h = volumeChecksum(record.slice(o, -2));
  record[record.length - 2] = h & 65535;
  record[record.length - 1] = h >>> 16;
  assert(cache.ingest(record, 1000));
  assertEquals(cache.snapshot(1000)!.volumes[0].native, true);
});

Deno.test("raw atlas assembly survives animated transforms and tint and updates only metadata", () => {
  const cache = new LightVolumeCache();
  function rawPage(page: number, tint: number) {
    const r = nativeVolumePage(page, [18, 4, 4]), o = LIGHTING.length;
    r[o + 1] = 4;
    r[o + 9] = 0;
    r[o + 12 + 3] = tint; // animated volume translation
    r[o + 12 + 20] = tint;
    r[o + 12 + 21] = 1;
    r[o + 12 + 22] = 1;
    const h = volumeChecksum(r.slice(o, -2));
    r[r.length - 2] = h & 65535;
    r[r.length - 1] = h >>> 16;
    return r;
  }
  assert(cache.ingest(rawPage(0, .25), 1000));
  assert(cache.ingest(rawPage(1, .5), 1001));
  assertEquals(cache.snapshot(1001), null);
  assert(cache.ingest(rawPage(2, .75), 1002));
  const s = cache.snapshot(1002)!;
  assertEquals(s.volumes[0].raw, true);
  const dataRevision = s.dataRevision, coefficients = s.volumes[0].coefficients;
  assertEquals(s.texture[60], 1);
  assert(cache.ingest(rawPage(0, 1), 1003));
  const updated = cache.snapshot(1003)!;
  assertEquals(updated.dataRevision, dataRevision);
  assertEquals(updated.volumes[0].coefficients, coefficients);
  assertEquals(updated.texture[3], 1);
  assertEquals(updated.texture[20], 1);
});
