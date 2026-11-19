// Scene-stream store probe: run through run.ts --probe=store.js. For FRAMES calls of the live
// buildPayload it extracts the same scene with a fresh extractor (full assets on its first call,
// no updateMatrixWorld, a throwaway camera), writes it and the live UI snapshot into a SceneStore
// through PetPlay's writer, and ships each delta through the binary codec into a replica, which
// checks the state hash.
// The wrapped function is restored afterwards; nothing is left on `state`.
const FRAMES = 60;
const url = (p) => new URL(p, moduleUrl).href;
// Cache-busted: the worker keeps modules from earlier runs.
const { PetplaySceneStoreWriter } = await import(`${url("../classes/sceneStoreWriter.ts")}?probe=${Date.now()}`);
const { decodeDelta, encodeDelta, SceneStore, TABLES } = await import(url("../submodules/raythree/src/store/mod.ts"));
const { RaythreeExtractor } = await import(url("../submodules/raythree/src/lib.ts"));
const { anchoredLowerers } = await import(url("../classes/overlayRenderTracking.ts"));

const bridge = state.raythreeSceneBridge;
const orig = bridge.buildPayload;
const scene = state.host.rootStore.getState().scene;
const camera = new THREE.PerspectiveCamera();
const extractor = new RaythreeExtractor({ lowerers: anchoredLowerers() });
const writer = new PetplaySceneStoreWriter();
const store = writer.store;
const replica = new SceneStore();
const rows = [];
let snapshot = null;
let error = null;

await new Promise((resolve) => {
  bridge.buildPayload = function (...args) {
    const p = orig.apply(this, args);
    try {
      const t0 = performance.now();
      const extraction = extractor.extract(scene, camera, { skipSceneMatrixWorldUpdate: true });
      const t1 = performance.now();
      const before = replica.sourceTick;
      writer.write(extraction, p.ui);
      const t2 = performance.now();
      const delta = snapshot == null ? store.snapshot() : store.changesSince(before);
      const bytes = encodeDelta(delta);
      const t3 = performance.now();
      replica.apply(decodeDelta(bytes));
      const t4 = performance.now();
      store.truncateJournal(replica.sourceTick);
      if (snapshot == null) {
        snapshot = {
          bytes: bytes.byteLength,
          perTable: Object.fromEntries(TABLES.map((t) => {
            const only = { ...delta, tables: delta.tables.filter((d) => d.table === t) };
            return [t, { rows: store.size(t), bytes: encodeDelta(only).byteLength }];
          })),
        };
      } else {
        rows.push({
          extractMs: t1 - t0,
          writeMs: t2 - t1,
          encodeMs: t3 - t2,
          applyMs: t4 - t3,
          committed: store.tick !== before,
          bytes: delta.tables.length ? bytes.byteLength : 0,
          rows: delta.tables.reduce((n, t) => n + t.upserts.length + t.removes.length, 0),
        });
      }
    } catch (e) {
      error ??= String(e?.stack ?? e);
    }
    if (rows.length >= FRAMES || error) { bridge.buildPayload = orig; resolve(); }
    return p;
  };
  setTimeout(() => { bridge.buildPayload = orig; resolve(); }, 12000);
});
delete bridge.buildPayload;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0).toFixed(3); };
const stat = (k) => ({ p50: pct(rows.map((r) => r[k]), 0.5), p95: pct(rows.map((r) => r[k]), 0.95) });
return JSON.stringify({
  frames: rows.length, error, restored: bridge.buildPayload === orig,
  snapshot,
  items: { total: store.size("items"), byNode: [...store.ids("items")].reduce((m, id) => { const n = store.get("items", id).header.node; m[n] = (m[n] ?? 0) + 1; return m; }, {}) },
  commitsPerFrame: rows.filter((r) => r.committed).length / Math.max(1, rows.length),
  deltaBytes: stat("bytes"), deltaRows: stat("rows"),
  extractMs: stat("extractMs"), writeMs: stat("writeMs"), encodeMs: stat("encodeMs"), applyMs: stat("applyMs"),
  replicaHashMatches: replica.hash().join() === store.hash().join(),
});
