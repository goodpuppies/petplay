/**
 * Development launcher that mirrors all PetPlay output to a persistent log.
 * Keeping this outside the application process preserves the final output when
 * a native FFI crash terminates PetPlay before it can run cleanup handlers.
 */

import { join } from "@std/path";

const logDirectory = join(Deno.cwd(), "logs");
await Deno.mkdir(logDirectory, { recursive: true });

const startedAt = new Date();
const stamp = startedAt.toISOString().replaceAll(":", "-").replace(".", "-");
const logPath = join(logDirectory, `petplay-${stamp}.log`);
const logFile = await Deno.open(logPath, { createNew: true, write: true });
const encoder = new TextEncoder();

let pendingLogWrite = Promise.resolve();
function appendToLog(chunk: Uint8Array): Promise<void> {
  const copy = chunk.slice();
  pendingLogWrite = pendingLogWrite.then(async () => {
    let written = 0;
    while (written < copy.length) {
      written += await logFile.write(copy.subarray(written));
    }
    await logFile.syncData();
  });
  return pendingLogWrite;
}

async function mirror(
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
): Promise<void> {
  const reader = source.getReader();
  const writer = destination.getWriter();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await Promise.all([writer.write(value), appendToLog(value)]);
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

const header = encoder.encode(
  `[petplay launcher] started=${startedAt.toISOString()} pid=${Deno.pid} log=${logPath}\n`,
);
await Promise.all([Deno.stdout.write(header), appendToLog(header)]);

const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    "--unstable-webgpu",
    "--env-file",
    "--no-check",
    "petplay/petplay.ts",
    "dev",
    ...Deno.args,
  ],
  cwd: Deno.cwd(),
  stdin: "inherit",
  stdout: "piped",
  stderr: "piped",
}).spawn();

const stdoutMirror = mirror(child.stdout, Deno.stdout.writable);
const stderrMirror = mirror(child.stderr, Deno.stderr.writable);
const status = await child.status;
await Promise.all([stdoutMirror, stderrMirror]);

const footer = encoder.encode(
  `[petplay launcher] exited=${
    new Date().toISOString()
  } code=${status.code} signal=${status.signal ?? "none"}\n`,
);
await Promise.all([Deno.stdout.write(footer), appendToLog(footer)]);
await pendingLogWrite;
logFile.close();
Deno.exit(status.code);
