import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { vrcDepthDebugStore as store } from "./vrcDepthDebugStore.ts";

Deno.test("clearing and replacing a scan advances its revision; hiding live depth keeps the scan", () => {
  const data = { positions: new Float32Array(18), colors: new Float32Array(18), count: 1 };
  store.setScan(data);
  const first = store.scan()!.revision;
  store.setScan(null);
  store.setScan(data);
  assert(store.scan()!.revision > first);
  store.setEnabled(false);
  assertEquals(store.mesh(), null);
  assertEquals(store.scan()!.count, 1);
  store.setEnabled(true);
  store.setScan(null);
});
