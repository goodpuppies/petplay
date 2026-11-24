/** End-to-end native actor test against the real Stageforge router; no SteamVR. */
import { type ActorId, PostalService } from "../submodules/stageforge/mod.ts";
import {
  decodeWebSocketWorkerMessage,
  encodeWebSocketWorkerMessage,
} from "../submodules/stageforge/src/lib/webSocketWorkerCodec.ts";
import { createStdioActorWorker } from "../submodules/petplay_ovrdriver/integration/stdio-worker.ts";
import { testNativeDriverProxy } from "./petplay-ovrdriver-proxy-test.ts";
import { fromFileUrl } from "@std/path";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
if (Deno.args.includes("--build")) {
  const buildFile = fromFileUrl(
    new URL("../submodules/petplay_ovrdriver/build.zig", import.meta.url),
  );
  for (const step of [[], ["test"]]) {
    const result = await new Deno.Command("zig", {
      args: ["build", "--build-file", buildFile, ...step],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!result.success) throw new Error(`Driver build/check failed: ${result.code}`);
  }
}
const WorkerClass = createStdioActorWorker({
  executable: fromFileUrl(
    new URL("../submodules/petplay_ovrdriver/zig-out/bin/petplay_ovrdriver_actor", import.meta.url),
  ),
  encode: encodeWebSocketWorkerMessage,
  decode: decodeWebSocketWorkerMessage,
});
const postal = new PostalService().registerWorker("native-driver-probe", WorkerClass);
const url = new URL("../submodules/petplay_ovrdriver/src/actor_host.zig", import.meta.url);
let id: ActorId | undefined;
try {
  id = await postal.add(
    url.href,
    url.href,
    undefined,
    "native-driver-probe",
  );
  const request = (type: string, payload: unknown = null) =>
    postal.PostMessage({ target: id!, type, payload }, true);
  const health = await request("HEALTH") as {
    actorId: string;
    details: { driverInitialized: boolean; processOwner: string };
  };
  assert(
    health.actorId === id && !health.details.driverInitialized,
    "native actor registration and real health",
  );
  const echoed = await request("ECHO", {
    unicode: "犬🐾",
    handle: 18446744073709551615n,
    nested: [true, null, 3.25],
  }) as { unicode: string; handle: bigint; nested: unknown[] };
  assert(
    echoed.unicode === "犬🐾" && echoed.handle === 18446744073709551615n &&
      echoed.nested[2] === 3.25,
    "wire-compatible Unicode, BigInt tags and nested values",
  );
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => request("ECHO", { i })));
  assert(replies.every((r, i) => (r as { i: number }).i === i), "concurrent callback correlation");
  let rejected = false;
  try {
    await request("UNSUPPORTED");
  } catch (error) {
    rejected = String(error).includes("Unsupported native actor message");
  }
  assert(rejected, "native dispatch errors reject Stageforge callback");
  assert(
    (await request("PING") as { language: string }).language === "zig",
    "actor survives rejected message",
  );
  assert(
    await request("SHUTDOWN") === true,
    "ordinary shutdown acknowledges without closing transport",
  );
  assert(
    (await request("PING") as { language: string }).language === "zig",
    "transport remains after SHUTDOWN",
  );
  await postal.shutdown(id); // Cooperative shutdown acknowledgment, then terminate only actor transport.
  id = undefined;
  console.log(
    "PASS: Stageforge registration, health, Unicode/BigInt roundtrip, 20 callbacks, error recovery, cooperative shutdown",
  );
} finally {
  if (id) await postal.shutdown(id);
}
await testNativeDriverProxy();
Deno.exit(0);
