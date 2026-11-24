/** Real driver DSO + socket + Stageforge proxy lifecycle, hosted by an offline fake vrserver. */
import { type ActorId, PostalService } from "../submodules/stageforge/mod.ts";
import { attachOpenVrDriverProxy } from "../classes/petplayOpenVrDriverProxy.ts";
import { fromFileUrl } from "@std/path";
function assert(v: unknown, message: string): asserts v {
  if (!v) throw new Error(message);
}
export async function testNativeDriverProxy() {
  const directory = await Deno.makeTempDir({ prefix: "petplay-driver-proxy-" });
  const executable = fromFileUrl(
    new URL("../submodules/petplay_ovrdriver/zig-out/bin/abi_consumer", import.meta.url),
  );
  const library = fromFileUrl(
    new URL("../submodules/petplay_ovrdriver/zig-out/lib/libpetplay_abi_test.so", import.meta.url),
  );
  const child = new Deno.Command(executable, {
    args: [library, "--serve", directory],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  const output = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const postal = new PostalService();
  let id: ActorId | undefined;
  let exit = false;
  void child.status.then(() => {
    exit = true;
  });
  try {
    assert(
      (await output.read()).value?.includes("READY"),
      "offline driver initialized its real IPC endpoint",
    );
    const socketPath = `${directory}/control.sock`;
    const mode = (await Deno.stat(socketPath)).mode! & 0o777;
    assert(mode === 0o600, "socket is current-user only");
    const contention = await new Deno.Command(executable, {
      args: [library, "--expect-no-ipc", directory],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    assert(contention.success, "a second provider cannot steal the live socket/lock");
    id = await attachOpenVrDriverProxy(postal, socketPath);
    const initialId = id;
    const request = (type: string, payload: unknown = null) =>
      postal.PostMessage({ target: id!, type, payload }, true);
    type Health = {
      actorId: string;
      details: {
        driverInitialized: boolean;
        runFrameCount: number;
        ipcSessions: number;
        processOwner: string;
      };
    };
    const first = await request("HEALTH") as Health;
    assert(
      first.actorId === id && first.details.driverInitialized &&
        first.details.runFrameCount === 3 && first.details.processOwner === "steamvr",
      "messages reach already-initialized library instance",
    );
    const echo = await request("ECHO", { handle: 0xffffffffffffffffn, text: "犬🐾" }) as {
      handle: bigint;
      text: string;
    };
    assert(
      echo.handle === 0xffffffffffffffffn && echo.text === "犬🐾",
      "native socket uses same codec",
    );
    await postal.shutdown(id);
    id = undefined;
    assert(!exit, "removing proxy leaves external process alive");
    id = await attachOpenVrDriverProxy(postal, socketPath);
    const second = await request("HEALTH") as Health;
    assert(
      id === initialId && second.details.runFrameCount === 3 &&
        second.details.ipcSessions > first.details.ipcSessions,
      "reattach preserves actor identity and driver state without INIT",
    );
    const pending = request("ECHO", { pending: true });
    postal.detachProxy(id);
    id = undefined;
    let rejected = false;
    try {
      await pending;
    } catch (error) {
      rejected = String(error).includes("detached");
    }
    assert(rejected, "detach rejects pending callback instead of waiting for timeout");
    id = await attachOpenVrDriverProxy(postal, socketPath);
    assert(id === initialId, "second detach also preserves identity");
    const began = performance.now();
    await writer.write(new TextEncoder().encode("q\n"));
    await writer.close();
    const result = await child.status;
    assert(
      result.success && performance.now() - began < 1000,
      "driver Cleanup joins IPC thread promptly while client is connected",
    );
    let cleaned = false;
    for (;;) {
      const chunk = await output.read();
      if (chunk.done) break;
      cleaned ||= chunk.value.includes("CLEANED");
    }
    assert(cleaned, "driver host reached orderly cleanup");
    let removed = false;
    try {
      await Deno.stat(socketPath);
    } catch (error) {
      removed = error instanceof Deno.errors.NotFound;
    }
    assert(removed, "cleanup removes socket endpoint");
    postal.detachProxy(id);
    id = undefined;
    const insecure = await Deno.makeTempDir({ prefix: "petplay-driver-insecure-" });
    try {
      await Deno.chmod(insecure, 0o755);
      const refused = await new Deno.Command(executable, {
        args: [library, "--expect-no-ipc", insecure],
        stdout: "piped",
        stderr: "inherit",
      }).output();
      assert(refused.success, "driver refuses a directory accessible to other users");
    } finally {
      await Deno.remove(insecure, { recursive: true });
    }
    console.log(
      "PASS: loaded pure Zig driver -> Unix IPC -> Stageforge proxy; detach/reattach, stable identity/state, pending-request rejection, bounded Cleanup",
    );
  } finally {
    if (id) postal.detachProxy(id);
    if (!exit) {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }
    await child.status;
    try {
      output.releaseLock();
    } catch { /* closed */ }
    await Deno.remove(directory, { recursive: true });
  }
}
if (import.meta.main) {
  await testNativeDriverProxy();
  Deno.exit(0);
}
