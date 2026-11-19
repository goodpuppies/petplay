// Scene-stream P0 probe (markdown/scene-stream): run through run.ts, or POST
// {"target":"webxr","code":<this file>,"timeoutMs":20000} to the agent REPL's /eval. Observes buildPayload for FRAMES calls (never calls it itself),
// then restores it, and inventories the live three scene read-only.
const FRAMES = 60;
const { serialize } = await import("node:v8");
const bridge = state.raythreeSceneBridge;
const orig = bridge.buildPayload;
const sz = (x) => serialize(x).byteLength;
const rows = [];
let prev = null;
const inv = { matKinds: {}, uniformKeys: {}, texSlots: {}, geomAttrs: {}, texFormats: {}, fonts: {}, assetBytes: { geometries: 0, materials: 0, textures: 0 }, assetCounts: { geometries: 0, materials: 0, textures: 0 } };
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const strip = ({ geometry, ...r }) => serialize(r).toString("base64");
const matKey = (m) => m ? Array.from(m).join(",") : "";
const anchoredOf = (xs) => xs.filter((x) => x.renderAnchor).length;
let lastPayload = null;
await new Promise((resolve) => {
  bridge.buildPayload = function (...args) {
    const t0 = performance.now();
    const p = orig.apply(this, args);
    const ms = performance.now() - t0;
    try {
      const ex = p.leftEye, inst = ex.frame.instances, ui = p.ui;
      for (const g of ex.assets.geometries) {
        inv.assetCounts.geometries++; inv.assetBytes.geometries += sz(g);
        for (const [n, a] of Object.entries(g.attributes)) bump(inv.geomAttrs, `${n}:${a.componentType}x${a.itemSize}`);
      }
      for (const m of ex.assets.materials) {
        inv.assetCounts.materials++; inv.assetBytes.materials += sz(m);
        bump(inv.matKinds, `${m.kind}/${m.state.blendMode}`);
        for (const k of Object.keys(m.uniforms ?? {})) bump(inv.uniformKeys, k);
        for (const t of m.textures ?? []) bump(inv.texSlots, t.slot);
      }
      for (const t of ex.assets.textures) {
        inv.assetCounts.textures++; inv.assetBytes.textures += sz(t);
        bump(inv.texFormats, `${t.format}/${t.width}x${t.height}/src=${t.source ? "key" : "none"}`);
      }
      for (const t of ui.texts) bump(inv.fonts, String(t.font));
      const cur = {
        inst: new Map(inst.map((i) => [i.nodeId, matKey(i.worldMatrix)])),
        panels: ui.panels.map(strip), texts: ui.texts.map(strip), images: ui.images.map(strip),
      };
      const row = {
        ms: +ms.toFixed(3),
        n: { inst: inst.length, panels: ui.panels.length, texts: ui.texts.length, images: ui.images.length, lights: ex.frame.lights.length },
        bytes: {
          instances: sz(inst), lights: sz(ex.frame.lights), camera: sz(ex.frame.camera), assetsDelta: sz(ex.assets),
          panels: sz(ui.panels), texts: sz(ui.texts), textGlyphGeometry: ui.texts.reduce((s, t) => s + (t.geometry ? t.geometry.positions.byteLength + t.geometry.uvs.byteLength + t.geometry.indices.byteLength + (t.geometry.vectorGlyphs?.byteLength ?? 0) : 0), 0),
          images: sz(ui.images), frame: sz(p.frame), whole: sz({ ...p, rightEye: undefined }),
        },
        anchored: { inst: inst.filter((i) => i.renderAnchor).length, panels: anchoredOf(ui.panels), texts: anchoredOf(ui.texts), images: anchoredOf(ui.images) },
      };
      if (prev) {
        let ic = 0; for (const [id, m] of cur.inst) if (prev.inst.get(id) !== m) ic++;
        const diff = (a, b) => { let c = Math.abs(a.length - b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) c++; return c; };
        row.changed = { inst: ic, panels: diff(cur.panels, prev.panels), texts: diff(cur.texts, prev.texts), images: diff(cur.images, prev.images) };
      }
      prev = cur;
      rows.push(row);
      lastPayload = p;
    } catch (e) { rows.push({ err: String(e?.stack ?? e) }); }
    if (rows.length >= FRAMES) { bridge.buildPayload = orig; resolve(); }
    return p;
  };
  setTimeout(() => { bridge.buildPayload = orig; resolve(); }, 12000);
});
delete bridge.buildPayload;
const restored = bridge.buildPayload === orig;

// Read-only traversal of the live three scene: what the IR has to represent before lowering.
const scene = state.host?.rootStore?.getState()?.scene;
const sceneInv = { objects: {}, materials: {}, nodeMaterials: 0, shaderMaterials: 0, textures: {}, geomAttrs: {}, visibleMeshes: 0, geometryBytes: 0, bridgeSkip: 0, renderAnchors: 0 };
if (scene) {
  const seenGeom = new Set(), seenTex = new Set();
  scene.traverse((o) => {
    bump(sceneInv.objects, o.type);
    if (o.userData?.bridge?.kind === "skip") sceneInv.bridgeSkip++;
    if (o.userData?.renderTrackingAnchor || o.userData?.renderAnchor) sceneInv.renderAnchors++;
    if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
    let shown = true;
    for (let n = o; n; n = n.parent) if (!n.visible) { shown = false; break; }
    if (shown) sceneInv.visibleMeshes++;
    for (const m of [o.material].flat().filter(Boolean)) {
      bump(sceneInv.materials, m.type ?? m.constructor?.name);
      if (m.isNodeMaterial) sceneInv.nodeMaterials++;
      if (m.isShaderMaterial) sceneInv.shaderMaterials++;
      for (const v of Object.values(m)) {
        if (v?.isTexture && !seenTex.has(v.uuid)) {
          seenTex.add(v.uuid);
          const img = v.image ?? v.source?.data;
          bump(sceneInv.textures, `${v.constructor?.name}:${img?.constructor?.name ?? "none"}:${img?.width ?? "?"}x${img?.height ?? "?"}`);
        }
      }
    }
    const g = o.geometry;
    if (g && !seenGeom.has(g.uuid)) {
      seenGeom.add(g.uuid);
      for (const [n, a] of Object.entries(g.attributes ?? {})) { bump(sceneInv.geomAttrs, n); sceneInv.geometryBytes += a.array?.byteLength ?? 0; }
      if (g.index) sceneInv.geometryBytes += g.index.array.byteLength;
    }
  });
}
const ok = rows.filter((r) => !r.err);
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
return JSON.stringify({
  frames: rows.length, errors: rows.filter((r) => r.err).slice(0, 2), restored,
  buildMs: { p50: pct(ok.map((r) => r.ms), 0.5), p95: pct(ok.map((r) => r.ms), 0.95) },
  counts: ok.at(-1)?.n, anchored: ok.at(-1)?.anchored, bytes: ok.at(-1)?.bytes,
  changedPerFrame: ok.filter((r) => r.changed).map((r) => r.changed),
  assetsDeltaFramesNonEmpty: ok.filter((r) => r.bytes.assetsDelta > 200).length,
  inv, sceneInv,
});
