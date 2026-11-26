/**
 * Attach a remote `overlayRenderOwner` (e.g. on a Windows SteamVR machine) to a running PetPlay
 * dev server over Stageforge + Iroh.
 *
 * Queries the local `agentRepl` for `webxr`'s actor id and direct Iroh endpoint (enabling
 * Stageforge networking if it is currently off), allowlists the remote peer's direct endpoint id,
 * and either:
 *   - `--ssh=<user@host> --remote-dir=<path>`: launches `utils/remote-overlay-renderer.ts` on the
 *     remote over SSH, performs the stdin handshake automatically, and streams its logs here.
 *   - `--allow-peer=<irohPeerId>`: allowlists that peer and prints the exact command to run on
 *     the remote machine.
 *   - (no flags): prints the local `webxr` actor id and direct Iroh endpoint.
 */
import { parseArgs } from "@std/cli/parse-args";
import { getAgentReplPort } from "../classes/utils.ts";
import type { IrohEndpoint } from "../classes/irohCarrier.ts";

const DIRECT_ENDPOINT_PREFIX = "REMOTE_RENDERER_DIRECT_ENDPOINT ";

const args = parseArgs(Deno.args, {
  string: [
    "repl",
    "allow-peer",
    "ssh",
    "remote-dir",
    "remote-deno",
    "link-binary",
    "mode",
    "banks",
    "eye-size",
    "remote-repl-port",
    "relay",
  ],
  boolean: ["local", "windows-session", "help"],
  default: {
    "remote-deno": "deno",
    mode: "panorama",
    local: false,
    "windows-session": false,
    help: false,
  },
});

if (args.help) {
  console.log(
    "Usage: deno run -A utils/remote-renderer-attach.ts [options]\n" +
      "  --repl=<url>               Local agentRepl URL (default: http://127.0.0.1:<port>)\n" +
      "  --allow-peer=<irohId>      Allowlist a remote direct peer id and print launch args\n" +
      "  --ssh=<user@host>          Launch remote-overlay-renderer.ts over SSH and handshake\n" +
      "  --remote-dir=<path>        PetPlay checkout directory on the SSH host\n" +
      "  --remote-deno=<cmd>        Deno binary on the SSH host (default: deno)\n" +
      "  --link-binary=<path>       petplay-media binary path on the remote host\n" +
      "  --mode=panorama|projection Present mode on the remote renderer (default: panorama)\n" +
      "  --banks=0|2|3              Shared bank count override on the remote renderer\n" +
      "  --eye-size=<px>            Eye size override on the remote renderer\n" +
      "  --remote-repl-port=<port>  Optional agentRepl port on the remote renderer\n" +
      "  --relay=<url>              Optional custom Iroh relay URL\n" +
      "  --local                    Pass --local to remote-overlay-renderer.ts",
  );
  Deno.exit(0);
}

const replBase = (args.repl || `http://127.0.0.1:${getAgentReplPort()}`).replace(/\/+$/, "");

async function replGet<T>(path: string): Promise<T> {
  const res = await fetch(`${replBase}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data as T;
}

async function replMessage<T>(
  target: string,
  type: string,
  payload: unknown = null,
  timeoutMs = 10000,
): Promise<T> {
  const res = await fetch(`${replBase}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, type, payload, reply: true, timeoutMs }),
  });
  const data = await res.json() as { ok?: boolean; result?: T; error?: { message?: string } };
  if (!res.ok || data.ok === false) {
    throw new Error(
      `POST /message ${target}/${type} failed: ${data.error?.message ?? JSON.stringify(data)}`,
    );
  }
  return data.result as T;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const registry = await replGet<{ actors: Record<string, string> }>("/registry");
const webxr = registry.actors?.webxr;
if (!webxr) {
  throw new Error(
    `No "webxr" actor found in ${replBase}/registry (got: ${Object.keys(registry.actors ?? {}).join(", ")})`,
  );
}

let endpoint = await replMessage<IrohEndpoint | null>("SYSTEM", "DIRECT_ENDPOINT", null);
if (!endpoint?.id) {
  console.log("[remote-attach] Stageforge networking not active yet; enabling via SYSTEM/SETNETWORKING...");
  await replMessage("SYSTEM", "SETNETWORKING", { enabled: true }, 15000);
  endpoint = await replMessage<IrohEndpoint | null>("SYSTEM", "DIRECT_ENDPOINT", null, 15000);
}
if (!endpoint?.id) {
  throw new Error("Host did not return a direct Iroh endpoint even after enabling networking");
}

console.log(`[remote-attach] host webxr=${webxr}`);
console.log(`[remote-attach] host direct endpoint=${JSON.stringify(endpoint)}`);

if (args["allow-peer"]) {
  const peerId = args["allow-peer"].trim();
  const ok = await replMessage<boolean>("SYSTEM", "ALLOW_DIRECT", { peerId });
  console.log(`[remote-attach] ALLOW_DIRECT(${peerId}) -> ${ok}`);
  const endpointJson = JSON.stringify(endpoint);
  console.log("\nRun on the remote machine:");
  console.log(
    `  deno run -A --no-check utils/remote-overlay-renderer.ts ` +
      `--webxr=${shellQuote(webxr)} --endpoint=${shellQuote(endpointJson)} --mode=${args.mode}` +
      (args.banks ? ` --banks=${args.banks}` : "") +
      (args["eye-size"] ? ` --eye-size=${args["eye-size"]}` : "") +
      (args["link-binary"] ? ` --link-binary=${shellQuote(args["link-binary"])}` : "") +
      (args["remote-repl-port"] ? ` --repl-port=${args["remote-repl-port"]}` : ""),
  );
  Deno.exit(0);
}

if (!args.ssh) {
  console.log("\nPass --ssh=<user@host> --remote-dir=<dir> to launch and attach automatically,");
  console.log("or --allow-peer=<remoteDirectPeerId> to allowlist a manually started renderer.");
  Deno.exit(0);
}

if (!args["remote-dir"]) {
  throw new Error("--remote-dir=<path> is required with --ssh");
}

if (args["windows-session"]) {
  // Windows SSH sessions run in Session 0 (services), where OpenVR IPC and hardware WGL/D3D11
  // are unavailable. Launch the renderer in the active interactive Console session via schtasks
  // and exchange the Iroh handshake via files.
  const remoteDir = args["remote-dir"];
  const readyName = "remote-renderer.ready.json";
  const handshakeName = "remote-renderer.handshake.json";
  const logName = "remote-renderer.log";
  const runnerName = "remote-renderer-run.cmd";
  const taskName = "PetPlayRemoteOverlayRenderer";

  const extraFlags = [
    `--mode=${args.mode}`,
    ...(args.banks ? [`--banks=${args.banks}`] : []),
    ...(args["eye-size"] ? [`--eye-size=${args["eye-size"]}`] : []),
    ...(args["link-binary"] ? [`--link-binary=${args["link-binary"]}`] : []),
    ...(args["remote-repl-port"] ? [`--repl-port=${args["remote-repl-port"]}`] : []),
    ...(args.relay ? [`--relay=${args.relay}`] : []),
    ...(args.local ? ["--local"] : []),
  ];

  async function sshRun(cmd: string): Promise<string> {
    const out = await new Deno.Command("ssh", {
      args: ["-o", "BatchMode=yes", args.ssh!, cmd],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    if (!out.success) {
      throw new Error(`ssh command failed (${out.code}): ${stderr || stdout}`);
    }
    return stdout;
  }

  // Write the launcher batch file and trigger it in the active Console session.
  const cmdBody = [
    "@echo off",
    `cd /d "%~dp0"`,
    `${args["remote-deno"]} run -A --no-check utils/remote-overlay-renderer.ts ` +
      `--ready-file=${readyName} --handshake-file=${handshakeName} ${extraFlags.join(" ")} ` +
      `> ${logName} 2>&1`,
  ].join("\r\n") + "\r\n";

  const setupScript = `
    set -e
    cd ${shellQuote(remoteDir)}
    rm -f ${readyName} ${readyName}.tmp ${handshakeName} ${handshakeName}.tmp ${logName}
    cat > ${runnerName} <<'PETPLAY_CMD_EOF'
${cmdBody}PETPLAY_CMD_EOF
    WIN_CMD=$(cygpath -w "$(pwd)/${runnerName}")
    MSYS_NO_PATHCONV=1 schtasks /Create /TN "${taskName}" /TR "cmd.exe /c \\"$WIN_CMD\\"" /SC ONCE /ST 00:00 /F >/dev/null
    MSYS_NO_PATHCONV=1 schtasks /Run /TN "${taskName}" >/dev/null
    MSYS_NO_PATHCONV=1 schtasks /Delete /TN "${taskName}" /F >/dev/null
  `;
  console.log(`[remote-attach] launching in Windows interactive session on ${args.ssh}...`);
  await sshRun(setupScript);

  let remoteReady: { pid: number; endpoint: IrohEndpoint } | null = null;
  const readyDeadline = performance.now() + 30_000;
  while (performance.now() < readyDeadline) {
    try {
      const raw = (await sshRun(
        `cd ${shellQuote(remoteDir)} && [ -f ${readyName} ] && cat ${readyName} || true`,
      )).trim();
      if (raw.length > 0) {
        remoteReady = JSON.parse(raw) as { pid: number; endpoint: IrohEndpoint };
        break;
      }
    } catch {
      // Keep polling.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!remoteReady?.endpoint?.id) {
    const logTail = await sshRun(
      `cd ${shellQuote(remoteDir)} && tail -n 40 ${logName} 2>/dev/null || true`,
    ).catch(() => "");
    throw new Error(`Timed out waiting for Windows renderer ready file.\n${logTail}`);
  }

  console.log(
    `[remote-attach] Windows renderer pid=${remoteReady.pid} direct=${remoteReady.endpoint.id}`,
  );
  const ok = await replMessage<boolean>("SYSTEM", "ALLOW_DIRECT", {
    peerId: remoteReady.endpoint.id,
  });
  if (!ok) throw new Error(`ALLOW_DIRECT rejected for ${remoteReady.endpoint.id}`);

  const handshakeJson = JSON.stringify({ webxr, endpoint });
  await sshRun(
    `cd ${shellQuote(remoteDir)} && cat > ${handshakeName}.tmp <<'PETPLAY_HS_EOF'\n${handshakeJson}\nPETPLAY_HS_EOF\nmv ${handshakeName}.tmp ${handshakeName}`,
  );
  console.log("[remote-attach] handshake delivered; tailing Windows renderer log (Ctrl-C to stop)...");

  const tailProc = new Deno.Command("ssh", {
    args: [
      "-o",
      "BatchMode=yes",
      args.ssh,
      `cd ${shellQuote(remoteDir)} && tail -n +1 -f ${logName}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const stopRemote = async () => {
    try {
      tailProc.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    await sshRun(
      `MSYS_NO_PATHCONV=1 taskkill /PID ${remoteReady!.pid} /T /F >/dev/null 2>&1 || true`,
    ).catch(() => {});
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => void stopRemote());
    } catch {
      // Ignore.
    }
  }
  const status = await tailProc.status;
  Deno.exit(status.code);
}

const remoteArgs = [
  args["remote-deno"],
  "run",
  "-A",
  "--no-check",
  "utils/remote-overlay-renderer.ts",
  "--handshake-stdin",
  `--mode=${args.mode}`,
  ...(args.banks ? [`--banks=${args.banks}`] : []),
  ...(args["eye-size"] ? [`--eye-size=${args["eye-size"]}`] : []),
  ...(args["link-binary"] ? [`--link-binary=${args["link-binary"]}`] : []),
  ...(args["remote-repl-port"] ? [`--repl-port=${args["remote-repl-port"]}`] : []),
  ...(args.relay ? [`--relay=${args.relay}`] : []),
  ...(args.local ? ["--local"] : []),
];

const remoteCmd = `cd ${shellQuote(args["remote-dir"])} && ${remoteArgs.map(shellQuote).join(" ")}`;
console.log(`[remote-attach] launching over ssh ${args.ssh}: ${remoteCmd}`);

const child = new Deno.Command("ssh", {
  args: ["-o", "BatchMode=yes", args.ssh, remoteCmd],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const encoder = new TextEncoder();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Ignore if already exited.
      }
    });
  } catch {
    // Ignore unsupported signals.
  }
}

let handshook = false;
const lines = child.stdout.pipeThrough(new TextDecoderStream());
let buffer = "";
for await (const chunk of lines) {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    console.log(line);
    if (!handshook && line.startsWith(DIRECT_ENDPOINT_PREFIX)) {
      const remoteEndpoint = JSON.parse(line.slice(DIRECT_ENDPOINT_PREFIX.length)) as IrohEndpoint;
      console.log(`[remote-attach] allowlisting remote peer ${remoteEndpoint.id}...`);
      const ok = await replMessage<boolean>("SYSTEM", "ALLOW_DIRECT", {
        peerId: remoteEndpoint.id,
      });
      if (!ok) throw new Error(`ALLOW_DIRECT rejected for ${remoteEndpoint.id}`);
      handshook = true;
      await writer.write(encoder.encode(`${JSON.stringify({ webxr, endpoint })}\n`));
      await writer.close();
      console.log("[remote-attach] handshake sent; remote renderer connecting over Iroh...");
    }
  }
}
if (buffer.trim()) console.log(buffer.trim());

const status = await child.status;
Deno.exit(status.code);
