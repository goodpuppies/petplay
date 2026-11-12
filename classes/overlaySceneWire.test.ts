import { decodeOverlayScene, encodeOverlayScene } from "./overlaySceneWire.ts";
import type { WebXRRaythreeRenderPayload } from "./webxrRaythreeScene.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";

Deno.test("scene packets retain typed buffers, ownership, and stereo aliases through process JSON", () => {
  const eye = { frame: { instances: [{ worldMatrix: new Float64Array([1, 2, 3]) }] } };
  const source = { leftEye: eye, rightEye: eye } as unknown as WebXRRaythreeRenderPayload;
  const packet = encodeOverlayScene(source);
  eye.frame.instances[0].worldMatrix[0] = 99;
  const decoded = decodeOverlayScene(
    decodeWebSocketWorkerMessage(
      encodeWebSocketWorkerMessage(packet),
    ) as typeof packet,
  );
  const matrix = decoded.leftEye.frame.instances[0].worldMatrix;
  if (!(matrix instanceof Float64Array) || matrix[0] !== 1) throw new Error("Buffer not preserved");
  if (decoded.leftEye !== decoded.rightEye) throw new Error("Stereo extraction copied twice");
  matrix[0] = 7;
  if (eye.frame.instances[0].worldMatrix[0] !== 99) throw new Error("Source ownership violated");
});

// Stateful transport retains glyph dependencies independently of rendered snapshots.
import { OverlaySceneWireDecoder, OverlaySceneWireEncoder } from "./overlaySceneWire.ts";
import type { SceneDelivery } from "./overlaySceneDelivery.ts";
import { Buffer } from "node:buffer";
import { deserialize } from "node:v8";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function scene(sequence: number, revision = 1, epoch = "producer", stream = "view") {
  const eye = { assets: { geometries: [], materials: [], textures: [] }, frame: { instances: [] } };
  return {
    frame: { frameCount: sequence },
    delivery: { epoch, stream, sequence, assetVersion: 0 },
    leftEye: eye,
    rightEye: eye,
    ui: {
      panels: [],
      images: [],
      texts: [{
        text: "unchanged keyboard",
        color: [1, 1, 1, 1],
        worldMatrix: new Float32Array(16),
        geometry: {
          vectorGlyphs: new Float32Array([65, 0, 0, 80, 0]),
          id: 1,
          revision,
          version: revision,
          positions: new Float32Array(4096).fill(revision),
          uvs: new Float32Array(4096),
          indices: new Uint16Array([0, 1, 2]),
        },
      }],
    },
  } as unknown as WebXRRaythreeRenderPayload;
}
function frame(
  decoder: OverlaySceneWireDecoder,
  packet: ReturnType<OverlaySceneWireEncoder["encode"]>,
) {
  const result = decoder.decode(packet);
  assert(!result.stale, "expected a new frame");
  return result.payload;
}
function assets(packet: ReturnType<OverlaySceneWireEncoder["encode"]>) {
  return deserialize(Buffer.from(packet.data, "base64")).uiGeometryAssets;
}
Deno.test("Glyph tuning changes survive scene transport with cached geometry", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  for (const [index, [exponent, weight]] of [[1,0], [0.85,0.125], [1,0]].entries()) {
    const source = scene(index + 1);
    source.ui.textRendering = {renderer:index === 1 ? "windfoil" : "glyph", panoramaFilter:"catmull-rom", glyphCoverageExponent:exponent, glyphWeightPixels:weight, glyphAaWidth:index === 1 ? 0.85 : 1};
    const packet = encoder.encode(source);
    const decoded = frame(decoder, packet);
    assert(JSON.stringify(decoded.ui.textRendering) === JSON.stringify(source.ui.textRendering), "tuning lost in transport");
    encoder.acknowledge(source.delivery!);
  }
});

Deno.test("acknowledged glyph buffers are omitted and retain consumer identity", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  const first = encoder.encode(scene(1)), a = frame(decoder, first);
  assert(encoder.acknowledge(a.delivery!), "receipt accepted");
  const second = encoder.encode(scene(2)), b = frame(decoder, second);
  assert(
    assets(second).length === 0 && second.data.length < first.data.length / 5,
    "static glyph buffers still transmitted",
  );
  assert(
    a.ui.texts[0].geometry === b.ui.texts[0].geometry,
    "unchanged decoded geometry lost identity",
  );
  assert(a.ui.texts[0] !== b.ui.texts[0], "per-frame UI state must stay independent");
  assert(b.leftEye === b.rightEye, "stereo alias lost");
  assert(b.ui.texts[0].geometry?.vectorGlyphs?.[0] === 65, "vector glyph placements lost across asset receipts");
});
Deno.test("lost receipts and skipped packets retain all glyph dependencies", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  encoder.encode(scene(1));
  const second = encoder.encode(scene(2));
  assert(assets(second).length === 1, "unreceipted first packet dependency was omitted");
  const b = frame(decoder, second);
  assert(b.ui.texts[0].geometry?.positions[0] === 1, "skipped baseline missing");
  assert(encoder.acknowledge(b.delivery!), "newer receipt rejected");
  encoder.encode(scene(3, 2));
  const fourth = encoder.encode(scene(4, 2));
  assert(assets(fourth).length === 1, "unreceipted geometry revision was omitted");
  assert(frame(decoder, fourth).ui.texts[0].geometry?.positions[0] === 2, "new revision missing");
});
Deno.test("stale frames cannot roll glyph revisions backwards and old receipts cannot regress watermark", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  const first = encoder.encode(scene(1)), second = encoder.encode(scene(2, 2));
  const b = frame(decoder, second);
  assert(encoder.acknowledge(b.delivery!), "new receipt");
  const old = decoder.decode(first);
  assert(old.stale, "old frame accepted");
  assert(
    encoder.acknowledge(old.delivery),
    "late valid receipt should release its glyph receipt slot",
  );
  const third = encoder.encode(scene(3, 2));
  assert(assets(third).length === 0, "old receipt regressed watermark");
  assert(
    frame(decoder, third).ui.texts[0].geometry?.positions[0] === 2,
    "new geometry replaced by stale revision",
  );
});
Deno.test("foreign or modified glyph receipts cannot suppress unsent assets", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  const a = frame(decoder, encoder.encode(scene(1)));
  assert(!encoder.acknowledge({ ...a.delivery!, stream: "other" }), "foreign receipt accepted");
  assert(
    !encoder.acknowledge({ ...a.delivery!, uiGeometryVersion: 999 }),
    "modified watermark accepted",
  );
  assert(assets(encoder.encode(scene(2))).length === 1, "invalid receipt suppressed dependencies");
});
Deno.test("new registration and producer epoch send baseline even with reused geometry ids", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  const old = encoder.encode(scene(1));
  const a = frame(decoder, old);
  encoder.acknowledge(a.delivery!);
  const fresh = encoder.encode(scene(1, 2, "producer", "new-view"));
  assert(assets(fresh).length === 1, "new view lacks baseline");
  assert(
    frame(decoder, fresh).ui.texts[0].geometry?.positions[0] === 2,
    "new view reused stale geometry",
  );
  assert(decoder.decode(old).stale, "retired stream reactivated");
  const restarted = encoder.encode(scene(1, 1, "new-producer", "new-view"));
  assert(
    frame(decoder, restarted).ui.texts[0].geometry?.positions[0] === 1,
    "epoch did not reset geometry identity",
  );
  assert(
    assets(new OverlaySceneWireEncoder().encode(scene(1))).length === 1,
    "fresh encoder lacks baseline",
  );
});
Deno.test("removed glyphs can reappear after consumer pruning without missing dependencies", () => {
  const encoder = new OverlaySceneWireEncoder(), decoder = new OverlaySceneWireDecoder();
  const a = frame(decoder, encoder.encode(scene(1)));
  encoder.acknowledge(a.delivery!);
  const empty = scene(2);
  empty.ui.texts = [];
  const b = frame(decoder, encoder.encode(empty));
  encoder.acknowledge(b.delivery!);
  const third = encoder.encode(scene(3));
  assert(assets(third).length === 1, "reappearing glyph omitted after pruning");
  assert(
    frame(decoder, third).ui.texts[0].geometry?.positions[0] === 1,
    "reappearing glyph missing",
  );
});
Deno.test("unidentified legacy glyphs remain inline and snapshots own serialized buffers", () => {
  const source = scene(1);
  delete source.ui.texts[0].geometry!.id;
  delete source.ui.texts[0].geometry!.revision;
  const packet = new OverlaySceneWireEncoder().encode(source);
  source.ui.texts[0].geometry!.positions[0] = 99;
  assert(assets(packet).length === 0, "legacy geometry unexpectedly referenced");
  assert(
    frame(new OverlaySceneWireDecoder(), packet).ui.texts[0].geometry?.positions[0] === 1,
    "serialized buffers alias producer",
  );
});
Deno.test("missing dependencies and memory budgets fail without poisoning decoder state", () => {
  const encoder = new OverlaySceneWireEncoder();
  const a = frame(new OverlaySceneWireDecoder(), encoder.encode(scene(1)));
  encoder.acknowledge(a.delivery!);
  const delta = encoder.encode(scene(2));
  const empty = new OverlaySceneWireDecoder();
  let missing = false;
  try {
    empty.decode(delta);
  } catch {
    missing = true;
  }
  assert(missing, "missing baseline accepted");
  const baseline = new OverlaySceneWireEncoder().encode(scene(1));
  assert(
    frame(empty, baseline).ui.texts[0].geometry?.positions[0] === 1,
    "failed decode poisoned state",
  );
  let bound = false;
  try {
    new OverlaySceneWireEncoder(16).encode(scene(1));
  } catch {
    bound = true;
  }
  assert(bound, "encoder budget ignored");
  bound = false;
  try {
    new OverlaySceneWireDecoder(16).decode(baseline);
  } catch {
    bound = true;
  }
  assert(bound, "decoder budget ignored");
});
