/**
 * Built-in end-to-end self-test (`petplay --test`).
 *
 * Boots a real PetPlay instance on an isolated agentRepl port (using the exact same binary in
 * compiled releases, or Deno in source checkouts) and verifies:
 *   1. Core actor graph boot (`main`, `webxr`, `wristMenu`)
 *   2. WebXR scene loop advancing frames with zero errors
 *   3. OpenVR attachment (when SteamVR is running and `--novr` is not set)
 *   4. Decoupled overlay renderer (`overlayRenderOwner`) publishing frames + native shared-bank
 *      transport (`DXGI` on Windows, `DMA-BUF` on Linux)
 *   5. Desktop screen capture (`displayOverlayHost` / `screen-streamer`)
 *   6. Clean shutdown
 *
 * Options:
 *   --novr          Skip OpenVR/VR checks (desktop/headless check only)
 *   --require-vr    Fail if SteamVR is not running / does not attach
 *   --json          Print machine-readable JSON summary at the end
 *   --timeout=<sec> Overall check timeout in seconds (default: 25)
 */
import { fromFileUrl } from "@std/path";
import { describeBuild } from "./buildInfo.ts";

type CheckStatus = "PASS" | "FAIL" | "SKIP";

type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseNumberArg(args: readonly string[], prefix: string, fallback: number): number {
  const raw = args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function runSelfTest(args: readonly string[]): Promise<number> {
  const novr = args.includes("--novr");
  const requireVr = args.includes("--require-vr");
  const jsonOutput = args.includes("--json");
  const timeoutSec = parseNumberArg(args, "--timeout=", 25);
  const port = 4100 + (Deno.pid % 500);
  const replBase = `http://127.0.0.1:${port}`;
  const results: CheckResult[] = [];
  const startedAt = performance.now();

  const record = (name: string, status: CheckStatus, detail: string, t0: number) => {
    const durationMs = Math.round(performance.now() - t0);
    results.push({ name, status, detail, durationMs });
    if (!jsonOutput) {
      const icon = status === "PASS" ? "[PASS]" : status === "SKIP" ? "[SKIP]" : "[FAIL]";
      console.log(`${icon} ${name} (${durationMs}ms): ${detail}`);
    }
  };

  if (!jsonOutput) {
    console.log(`PetPlay self-test — ${describeBuild()} (${Deno.build.target})`);
  }

  const childArgs = Deno.build.standalone
    ? [
      "dev",
      "--agent-repl",
      `--agent-repl-port=${port}`,
      "--no-update-check",
      "--no-log-file",
      ...(novr ? ["--novr"] : ["--openvr-reattach", "--dev-start-desktop-overlay"]),
    ]
    : [
      "run",
      "-A",
      "--unstable-webgpu",
      "--no-check",
      fromFileUrl(new URL("../petplay/petplay.ts", import.meta.url)),
      "dev",
      "--agent-repl",
      `--agent-repl-port=${port}`,
      "--no-update-check",
      "--no-log-file",
      ...(novr ? ["--novr"] : ["--openvr-reattach", "--dev-start-desktop-overlay"]),
    ];

  const logLines: string[] = [];
  const child = new Deno.Command(Deno.execPath(), {
    args: childArgs,
    env: {
      ...Deno.env.toObject(),
      PETPLAY_STAGEFORGE_NETWORKING: "0",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            logLines.push(line);
            if (logLines.length > 120) logLines.shift();
          }
        }
      }
    } catch {
      // Stream closed during teardown.
    }
  };
  const drainOut = drain(child.stdout);
  const drainErr = drain(child.stderr);

  const childState: { exited: Deno.CommandStatus | null } = { exited: null };
  const exitPromise = child.status.then((s) => {
    childState.exited = s;
    return s;
  });

  const overallDeadline = performance.now() + timeoutSec * 1000;

  try {
    // 1. Boot + core actors
    const tBoot = performance.now();
    let registry: { actors?: Record<string, string> } | null = null;
    while (performance.now() < overallDeadline && !childState.exited) {
      try {
        const r = await fetchJson<{ actors?: Record<string, string> }>(`${replBase}/registry`, undefined, 1500);
        if (r.actors?.main && r.actors?.webxr) {
          registry = r;
          break;
        }
      } catch {
        // Still booting.
      }
      await sleep(250);
    }
    if (!registry) {
      record(
        "boot",
        "FAIL",
        childState.exited
          ? `PetPlay exited prematurely with code ${childState.exited.code}`
          : `Timed out waiting for agentRepl on port ${port}`,
        tBoot,
      );
      throw new Error("boot failed");
    }
    record(
      "boot",
      "PASS",
      `actors=[${Object.keys(registry.actors ?? {}).join(", ")}]`,
      tBoot,
    );

    // 2. WebXR scene loop advancing frames
    const tWebxr = performance.now();
    let webxrDetails: Record<string, unknown> | null = null;
    while (performance.now() < overallDeadline && !childState.exited) {
      try {
        const res = await fetchJson<{
          health?: { details?: Record<string, unknown> };
        }>(`${replBase}/health/actor?actor=webxr`, undefined, 2500);
        const d = res.health?.details;
        if (d && Number(d.frameCount ?? 0) >= 3) {
          webxrDetails = d;
          break;
        }
      } catch {
        // Keep polling.
      }
      await sleep(300);
    }
    if (!webxrDetails || webxrDetails.error) {
      record(
        "webxr",
        "FAIL",
        webxrDetails?.error
          ? `webxr error: ${webxrDetails.error}`
          : "webxr did not advance frames in time",
        tWebxr,
      );
    } else {
      record(
        "webxr",
        "PASS",
        `frameCount=${webxrDetails.frameCount} xrFps=${Math.round(Number(webxrDetails.xrFps ?? 0))}`,
        tWebxr,
      );
    }

    // 3. OpenVR attach check
    const tVr = performance.now();
    let attached = false;
    let mainPhase = "unknown";
    if (novr) {
      record("openvr", "SKIP", "--novr requested", tVr);
    } else {
      const vrDeadline = Math.min(overallDeadline, performance.now() + 8000);
      while (performance.now() < vrDeadline && !childState.exited) {
        try {
          const res = await fetchJson<{
            health?: { details?: { phase?: string; openvrReady?: boolean } };
          }>(`${replBase}/health/actor?actor=main`, undefined, 2500);
          mainPhase = res.health?.details?.phase ?? "unknown";
          if (mainPhase === "attached" || res.health?.details?.openvrReady === true) {
            attached = true;
            break;
          }
        } catch {
          // Keep polling.
        }
        await sleep(300);
      }
      if (attached) {
        record("openvr", "PASS", `supervisor phase=${mainPhase}`, tVr);
      } else {
        record(
          "openvr",
          requireVr ? "FAIL" : "SKIP",
          `SteamVR did not attach (phase=${mainPhase})`,
          tVr,
        );
      }
    }

    // 4. Decoupled overlay renderer + native shared-bank transport
    const tRender = performance.now();
    if (!attached) {
      record("renderer", "SKIP", "OpenVR not attached", tRender);
      record("presenter_native", "SKIP", "OpenVR not attached", tRender);
    } else {
      type IndStatus = {
        running?: boolean;
        publishedFrames?: number;
        transport?: string;
        presentMode?: string;
        dmabufBanks?: number;
        error?: string | null;
        lastPresent?: { gpuFinishMs?: number; publicationMs?: number } | null;
      };
      let ind: IndStatus | null = null;
      const renderDeadline = Math.min(overallDeadline, performance.now() + 12000);
      while (performance.now() < renderDeadline && !childState.exited) {
        try {
          const res = await fetchJson<{
            health?: {
              details?: {
                independentRenderer?: { enabled?: boolean; status?: IndStatus | null };
              };
            };
          }>(`${replBase}/health/actor?actor=webxr`, undefined, 2500);
          const status = res.health?.details?.independentRenderer?.status ?? null;
          if (status && (Number(status.publishedFrames ?? 0) >= 5 || status.error)) {
            ind = status;
            break;
          }
        } catch {
          // Keep polling.
        }
        await sleep(350);
      }
      if (!ind || ind.error || Number(ind.publishedFrames ?? 0) < 1) {
        record(
          "renderer",
          "FAIL",
          ind?.error
            ? `overlayRenderOwner error: ${ind.error}`
            : `overlayRenderOwner publishedFrames=${ind?.publishedFrames ?? 0}`,
          tRender,
        );
        record("presenter_native", "FAIL", "renderer did not publish frames", tRender);
      } else {
        const pubUs = ind.lastPresent?.publicationMs != null
          ? `${(ind.lastPresent.publicationMs * 1000).toFixed(1)}us`
          : "n/a";
        const finMs = ind.lastPresent?.gpuFinishMs != null
          ? `${ind.lastPresent.gpuFinishMs.toFixed(2)}ms`
          : "n/a";
        record(
          "renderer",
          "PASS",
          `published=${ind.publishedFrames} mode=${ind.presentMode} banks=${ind.dmabufBanks} gpuFinish=${finMs} flip=${pubUs} transport="${ind.transport}"`,
          tRender,
        );
        const transport = ind.transport ?? "";
        const expectedPrefix = Deno.build.os === "windows" ? "DXGI " : "DMA-BUF ";
        if (Deno.build.os === "windows" || Deno.build.os === "linux") {
          if (transport.startsWith(expectedPrefix)) {
            record("presenter_native", "PASS", `shared-bank active: "${transport}"`, tRender);
          } else {
            record(
              "presenter_native",
              "FAIL",
              `expected ${expectedPrefix.trim()} shared-bank transport, got "${transport}"`,
              tRender,
            );
          }
        } else {
          record("presenter_native", "SKIP", `unsupported OS ${Deno.build.os}`, tRender);
        }
      }
    }

    // 5. Desktop capture (`displayOverlayHost`)
    const tCap = performance.now();
    if (!attached) {
      record("desktop_capture", "SKIP", "OpenVR not attached", tCap);
    } else {
      type DohStatus = {
        running?: boolean;
        glReady?: boolean;
        screenCaptureActive?: boolean;
        captureFps?: number;
        captureFramesPresented?: number;
        screenCapture?: { connected?: boolean; receivedFrame?: boolean } | null;
      };
      let doh: DohStatus | null = null;
      const capDeadline = Math.min(overallDeadline, performance.now() + 8000);
      while (performance.now() < capDeadline && !childState.exited) {
        try {
          const res = await fetchJson<{
            health?: { details?: DohStatus };
          }>(`${replBase}/health/actor?actor=displayOverlayHost`, undefined, 2500);
          const d = res.health?.details ?? null;
          if (d) {
            doh = d;
            if (d.screenCaptureActive && (d.captureFramesPresented ?? 0) > 0) break;
          }
        } catch {
          // Keep polling.
        }
        await sleep(350);
      }
      if (!doh) {
        record("desktop_capture", "FAIL", "displayOverlayHost actor unreachable", tCap);
      } else if (!doh.glReady) {
        record("desktop_capture", "FAIL", "displayOverlayHost GL not ready", tCap);
      } else if (doh.screenCaptureActive || doh.screenCapture?.connected) {
        record(
          "desktop_capture",
          "PASS",
          `connected=true framesPresented=${doh.captureFramesPresented ?? 0} fps=${Math.round(doh.captureFps ?? 0)}`,
          tCap,
        );
      } else {
        record(
          "desktop_capture",
          "FAIL",
          `capture not connected (running=${doh.running}, glReady=${doh.glReady}, frames=${doh.captureFramesPresented ?? 0})`,
          tCap,
        );
      }
    }
  } catch {
    // Error already recorded.
  } finally {
    // 6. Clean shutdown
    const tStop = performance.now();
    if (!childState.exited) {
      try {
        await fetchJson(`${replBase}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: "main", type: "PREPARESHUTDOWN", payload: null, reply: true }),
        }, 2500);
      } catch {
        // Best-effort.
      }
      try {
        child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM");
      } catch {
        // Already exited.
      }
      const exited = await Promise.race([
        exitPromise.then(() => true),
        sleep(5000).then(() => false),
      ]);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore.
        }
        await Promise.race([exitPromise, sleep(2000)]);
      }
      record("shutdown", exited ? "PASS" : "FAIL", exited ? "clean exit" : "forced kill after timeout", tStop);
    } else {
      record("shutdown", "FAIL", `exited early with code ${childState.exited.code}`, tStop);
    }
    await Promise.allSettled([drainOut, drainErr]);
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const totalMs = Math.round(performance.now() - startedAt);
  const ok = failed.length === 0;

  if (jsonOutput) {
    console.log(JSON.stringify({ ok, build: describeBuild(), target: Deno.build.target, totalMs, checks: results }, null, 2));
  } else {
    console.log(
      `\nSelf-test ${ok ? "PASSED" : "FAILED"} (${results.filter((r) => r.status === "PASS").length} passed, ` +
        `${results.filter((r) => r.status === "SKIP").length} skipped, ${failed.length} failed) in ${totalMs}ms`,
    );
    if (!ok && logLines.length > 0) {
      console.log("\n--- Last server log lines ---");
      for (const line of logLines.slice(-25)) console.log(line);
    }
  }
  return ok ? 0 : 1;
}
