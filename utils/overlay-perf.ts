/**
 * Overlay performance workflow — CLI half (see `utils/overlay-perf-harness.ts` for the in-isolate
 * half).
 *
 * Measures the WebXR overlay's per-frame CPU from inside the `webxr` actor through the agent REPL,
 * either against a session that is already running (`--attach`) or against a headless desktop build
 * it launches itself (`--launch`, scripted synthetic controller interaction).
 *
 * ```sh
 * deno task overlay:perf -- --launch                    # windowless run, full scenario set
 * deno task overlay:perf -- --launch --seconds=6         # longer phases
 * deno task overlay:perf -- --launch --scenario=hover,drag
 * deno task overlay:perf -- --launch --profile           # also capture a V8 profile of the worker
 * deno task overlay:perf -- --attach                     # measure a session you already have open
 * deno task overlay:perf -- --attach --seconds=30        # watch your own VR session (no input)
 * ```
 *
 * `--attach` never installs synthetic input: a session with a live IVRInput (a headset run) refuses
 * synthesized controllers outright, so attaching only observes it.
 */

import { dirname, fromFileUrl, join } from "@std/path";

type ScenarioName = "idle" | "hover" | "trigger" | "drag" | "sweep" | "scroll";

type PhaseSample = {
  second: number;
  frames: number;
  fps: number;
  r3fAvgMs: number | null;
  r3fMaxMs: number | null;
  rafAvgMs: number | null;
  overlayFrames: number | null;
  overlayFps: number | null;
};

type PhaseResult = {
  phase: ScenarioName | "observe";
  seconds: number;
  frames: number;
  fps: number;
  r3fAvgMs: number | null;
  r3fMaxMs: number | null;
  overlayFrames: number | null;
  overlayFps: number | null;
  samples: PhaseSample[];
};

type HarnessReport = {
  installMode: "synthetic" | "none";
  spatialLayerWasVisible: boolean;
  target: { id: string; position: [number, number, number] } | null;
  phases: PhaseResult[];
  profile: { path: string; durationMs: number } | null;
  warnings: string[];
};

const ALL_SCENARIOS: ScenarioName[] = ["idle", "hover", "trigger", "drag", "sweep", "scroll"];

const args = Deno.args;
// The `overlay:perf` task passes `--launch`; an explicit `--attach` overrides it.
const useLaunch = args.includes("--launch") && !args.includes("--attach");
const asJson = args.includes("--json");
const verbose = args.includes("--verbose");
const profileArg = args.find((arg) => arg === "--profile" || arg.startsWith("--profile="));

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function argNumber(name: string, fallback: number): number {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function scenarioList(): ScenarioName[] {
  const raw = argValue("scenario", "all");
  if (raw === "none") return [];
  if (raw === "all") return [...ALL_SCENARIOS];
  const requested = raw.split(",").map((entry) => entry.trim());
  const unknown = requested.filter((entry) => !ALL_SCENARIOS.includes(entry as ScenarioName));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenario(s) ${unknown.join(", ")}; known: ${ALL_SCENARIOS.join(", ")}, none, all`,
    );
  }
  return requested as ScenarioName[];
}

const port = argNumber("port", 3987);
const secondsPerScenario = argNumber("seconds", 4);
const targetId = argValue("target", "display-1");
const hand = argValue("hand", "right") === "left" ? "left" : "right";
const profileSeconds = argNumber("profile-seconds", 12);
const projectRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
// The harness is `await import`ed inside a long-lived actor worker, whose module cache is per
// process: a cache-busting query keeps edits to the harness effective without restarting petplay.
const harnessPath = new URL("./overlay-perf-harness.ts", import.meta.url);
const harnessStat = await Deno.stat(harnessPath);
harnessPath.searchParams.set("v", String(harnessStat.mtime?.getTime() ?? 0));
const harnessUrl = harnessPath.href;

async function replRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

async function replHealth(): Promise<{ ok: boolean; actors?: Record<string, string> }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) throw new Error(`/health failed (${response.status})`);
  return await response.json() as { ok: boolean; actors?: Record<string, string> };
}

/**
 * Runs `code` in the `webxr` actor and returns the resulting string.
 *
 * The actor inspects results with `Deno.inspect`, so a string comes back as a JS string literal
 * (single- or double-quoted depending on its content). `parseInspectedString` turns that literal
 * back into the string; the harness therefore returns a `JSON.stringify(...)` of its report.
 */
async function evalInWebxr(code: string, timeoutMs: number): Promise<string> {
  const body = await replRequest<{
    ok: boolean;
    result?: { ok: boolean; type: string; inspected?: string; error?: string };
    error?: { message?: string } | string;
  }>("/eval", { target: "webxr", code, timeoutMs });
  const result = body.result;
  if (result == null || result.ok !== true) {
    const reason = result?.error ?? JSON.stringify(body.error ?? body);
    throw new Error(`eval failed: ${reason.split("\n")[0]}`);
  }
  return parseInspectedString(result.inspected ?? "");
}

/** Inverse of `Deno.inspect` for a string result; only escapes inspect can emit are handled. */
function parseInspectedString(inspected: string): string {
  const quote = inspected[0];
  if ((quote !== '"' && quote !== "'") || inspected.at(-1) !== quote) {
    throw new Error(`unexpected REPL result shape: ${inspected.slice(0, 120)}`);
  }
  return inspected
    .slice(1, -1)
    .replace(/\\(.)/g, (_match, escaped: string) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        default:
          return escaped;
      }
    });
}

async function waitForRepl(timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const health = await replHealth();
      if (health.actors?.webxr != null) return;
    } catch {
      // REPL not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `agent REPL on port ${port} did not expose the webxr actor within ${timeoutMs}ms`,
  );
}

type LaunchedRun = { stop: () => Promise<void>; logPath: string; layoutPath: string };

/** Starts a windowless desktop build with the agent REPL, mirroring its output to `logs/`. */
async function launchHeadlessRun(): Promise<LaunchedRun> {
  const logDirectory = join(projectRoot, "logs");
  await Deno.mkdir(logDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const logPath = join(logDirectory, `overlay-perf-${stamp}.log`);
  const logFile = await Deno.open(logPath, { createNew: true, write: true });
  // A launched run starts from the default spatial graph and never touches the user's saved layout:
  // the overlay persists on every graph commit and the scenarios move nodes.
  const layoutPath = join(projectRoot, "tmp", "overlay-perf-layout.json");
  await Deno.remove(layoutPath).catch(() => {
    // No leftover layout from a previous run.
  });

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-webgpu",
      "--env-file",
      "--no-check",
      "petplay/petplay.ts",
      "dev",
      "--novr",
      "--agent-repl",
      "--webxr-frame-logs",
    ],
    cwd: projectRoot,
    env: { PETPLAY_SPATIAL_LAYOUT_PATH: layoutPath },
    stdin: "null",
    stdout: verbose ? "inherit" : "piped",
    stderr: verbose ? "inherit" : "piped",
  }).spawn();

  const mirror = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (stream == null) return;
    for await (const chunk of stream) await logFile.write(chunk);
  };
  const mirrored = [
    mirror(verbose ? null : child.stdout),
    mirror(verbose ? null : child.stderr),
  ];

  return {
    logPath,
    layoutPath,
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      const status = await child.status;
      await Promise.all(mirrored);
      logFile.close();
      if (!verbose && status.signal !== "SIGTERM" && status.code !== 0 && status.code !== 143) {
        console.error(`[overlay-perf] launched run exited with code=${status.code}`);
      }
    },
  };
}

function formatMs(value: number | null): string {
  return value == null ? "-" : `${value.toFixed(2)}ms`;
}

function printReport(
  report: HarnessReport,
  logPath: string | null,
  scratchLayoutPath: string | null,
): void {
  if (asJson) {
    console.log(JSON.stringify({ ...report, logPath }, null, 2));
    return;
  }

  console.log(
    `[overlay-perf] input=${report.installMode} target=${
      report.target
        ? `${report.target.id} @ [${report.target.position.map((v) => v.toFixed(3)).join(", ")}]`
        : "<none>"
    }`,
  );
  // A launched run restores its own scratch layout file; that is expected, not a warning.
  for (const warning of report.warnings) {
    if (scratchLayoutPath != null && warning.includes(scratchLayoutPath)) continue;
    console.log(`[overlay-perf] warning: ${warning}`);
  }

  const hasOverlay = report.phases.some((phase) => phase.overlayFps != null);
  const header = [
    "phase".padEnd(8),
    "sec".padStart(3),
    "fps".padStart(6),
    "r3f avg".padStart(9),
    "r3f max".padStart(9),
    "raf avg".padStart(9),
    ...(hasOverlay ? ["ovl fps".padStart(8)] : []),
  ].join("  ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const phase of report.phases) {
    const rafSamples = phase.samples.map((sample) => sample.rafAvgMs).filter((value) =>
      value != null
    );
    const rafAvg = rafSamples.length > 0
      ? rafSamples.reduce((total, value) => total + value!, 0) / rafSamples.length
      : null;
    console.log([
      phase.phase.padEnd(8),
      String(phase.seconds).padStart(3),
      phase.fps.toFixed(1).padStart(6),
      formatMs(phase.r3fAvgMs).padStart(9),
      formatMs(phase.r3fMaxMs).padStart(9),
      (rafAvg == null ? "-" : formatMs(rafAvg)).padStart(9),
      ...(hasOverlay
        ? [(phase.overlayFps == null ? "-" : phase.overlayFps.toFixed(1)).padStart(8)]
        : []),
    ].join("  "));
  }
  if (logPath != null) console.log(`\n[overlay-perf] run log: ${logPath}`);
}

type ProfileNode = {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
};
type CpuProfile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

/** Self time per function, plus GC share, from a V8 `.cpuprofile`. */
function analyzeProfile(path: string, top: number): void {
  const profile = JSON.parse(Deno.readTextFileSync(path)) as CpuProfile;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicros = new Map<string, number>();
  let total = 0;
  let idle = 0;
  let gc = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index]!;
    const delta = Math.max(profile.timeDeltas[index] ?? 0, 0);
    total += delta;
    const frame = nodes.get(id)?.callFrame;
    const name = frame?.functionName ?? "(anonymous)";
    const url = (frame?.url ?? "").split("/").slice(-1)[0] ?? "";
    if (name === "(idle)") idle += delta;
    if (name === "(garbage collector)") gc += delta;
    const key = `${name} @ ${url}:${(frame?.lineNumber ?? -1) + 1}`;
    selfMicros.set(key, (selfMicros.get(key) ?? 0) + delta);
  }
  const busy = Math.max(total - idle, 1);
  const ranked = [...selfMicros.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n[cpuprofile] ${path}`);
  console.log(
    `[cpuprofile] ${(total / 1000).toFixed(0)}ms wall, ${(busy / 1000).toFixed(0)}ms busy (${
      (100 * busy / total).toFixed(0)
    }%), gc ${(gc / 1000).toFixed(0)}ms` +
      " — profiling itself inflates these, use them for attribution, not absolutes",
  );
  for (const [key, micros] of ranked.slice(0, top)) {
    // Idle/program and the inspector's own frames are noise for attribution.
    if (key.startsWith("(idle)") || key.startsWith("(program)") || key.includes("inspector.js")) {
      continue;
    }
    console.log(
      `  ${(micros / 1000).toFixed(1).padStart(8)}ms  ${
        (100 * micros / busy).toFixed(1).padStart(5)
      }% busy  ${key}`,
    );
  }
}

const scenarios = scenarioList();
const profilePath = profileArg == null
  ? null
  : profileArg.includes("=")
  ? profileArg.slice("--profile=".length)
  : join(projectRoot, "tmp", `overlay-perf-${Date.now()}.cpuprofile`);

/** True when a petplay session already answers on the configured REPL port. */
async function replIsLive(): Promise<boolean> {
  try {
    const health = await replHealth();
    return health.actors?.webxr != null;
  } catch {
    return false;
  }
}

async function assertPortFree(): Promise<void> {
  if (await replIsLive()) {
    throw new Error(
      `port ${port} already serves a petplay session; stop it (or measure it with --attach instead of --launch)`,
    );
  }
}

async function main(): Promise<void> {
  const launched = useLaunch
    ? await (async () => {
      await assertPortFree();
      return await launchHeadlessRun();
    })()
    : null;

  try {
    if (launched != null) {
      // The launched process owns the port; wait until its REPL exposes the actor tree.
      await waitForRepl(90_000);
      // The webxr actor exists before its host is up; the harness waits for the scene itself.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    } else {
      if (!await replIsLive()) {
        throw new Error(
          `no petplay session on port ${port}; start one (deno task dev / dev:desktop) or use --launch`,
        );
      }
    }
    if (profilePath != null) await Deno.mkdir(dirname(profilePath), { recursive: true });

    const options = {
      scenarios,
      secondsPerScenario,
      targetId,
      hand,
      ...(profilePath == null
        ? {}
        : { profile: { path: profilePath, durationMs: profileSeconds * 1000 } }),
    };
    const sessionMs = Math.max(
      30_000,
      scenarios.length * secondsPerScenario * 1000 +
        (profilePath == null ? 0 : profileSeconds * 1000) + 20_000,
    );
    const raw = await evalInWebxr(
      `const harness = await import(${JSON.stringify(harnessUrl)});` +
        `return JSON.stringify(await harness.runOverlayPerfSession(host, state, ${
          JSON.stringify(options)
        }));`,
      sessionMs,
    );
    const report = JSON.parse(raw) as HarnessReport;
    printReport(report, launched?.logPath ?? null, launched?.layoutPath ?? null);
    if (report.profile != null) analyzeProfile(report.profile.path, 15);
  } finally {
    await launched?.stop();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[overlay-perf] ${error instanceof Error ? error.message : String(error)}`);
  Deno.exitCode = 1;
}
