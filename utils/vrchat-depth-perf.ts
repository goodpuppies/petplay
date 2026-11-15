/**
 * Resource baseline for VRChat depth in VR (`markdown/vrchat-depth/cpu-gpu-audit.md`): measures a
 * running server over a window and writes one JSON record, so a later change is compared with the
 * same method.
 *
 *   deno run -A utils/vrchat-depth-perf.ts --label=before [--seconds=20] [--out=_scratch/perf/baselines]
 *   deno run -A utils/vrchat-depth-perf.ts --compare=a.json,b.json
 *
 * Per process (VRChat, SteamVR, PetPlay main, depth intake, GPU capture helper, other PetPlay
 * children): CPU % of one core from /proc stat, GPU % from amdgpu fdinfo (`drm-engine-gfx`).
 * The main process's busiest threads. The webxr worker's per-stage frame timers (cumulative
 * `totalMs`/`count` in its state) differenced over the window, headset overlay fps and dropped
 * presents, depth frames per second, and the depth options in effect. Reads only; changes nothing.
 */
import { getAgentReplBaseUrl } from "../classes/utils.ts";

const args = Deno.args;
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = getAgentReplBaseUrl();
const CLOCK_TICKS = 100; // getconf CLK_TCK on Linux x86_64

if (flag("compare")) {
  compare(flag("compare")!.split(","));
  Deno.exit(0);
}

const seconds = Number(flag("seconds") ?? 20);
const label = flag("label") ?? "baseline";
const outDir = flag("out") ?? "_scratch/perf/baselines";

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return await r.json();
}
const health = await (await fetch(`${base}/health`)).json();
const actors = health.actors as Record<string, string>;
const message = async (target: string, type: string, payload: unknown = null) => {
  const r = await post("/message", { target, type, payload, reply: true, timeoutMs: 15000 });
  if (!r.ok) throw new Error(`${type} on ${target}: ${JSON.stringify(r.error)}`);
  return r.result;
};

/** The webxr worker's cumulative stage timers and counters. */
const METRICS = [
  "raylibHostPrepMetric",
  "raythreeExtractMetric",
  "raythreeSceneMatrixMetric",
  "raythreeLeftEyeMetric",
  "raythreeUiMetric",
  "raylibOvrRenderMetric",
  "raylibOvrEyeLeftMetric",
  "raylibOvrEyeRightMetric",
  "raylibOvrCombineMetric",
  "raylibOvrSyncMetric",
  "uploadMetric",
  "presentMetric",
  "frameMetric",
];
async function webxrSnapshot() {
  const code =
    `(()=>{const o={at:performance.now(),dropped:Number(state.raylibPresentDropped??0)};` +
    `for(const k of ${
      JSON.stringify(METRICS)
    }){const m=state[k];if(m&&typeof m.totalMs==="number")` +
    `o[k]={totalMs:m.totalMs,count:m.count};}return JSON.stringify(o)})()`;
  const r = await post("/eval", { target: actors.webxr, code, timeoutMs: 10000 });
  // `/eval` answers with `Deno.inspect` of the value: a JSON string comes back single-quoted.
  const inspected = String(r?.result?.inspected ?? "");
  return JSON.parse(inspected.startsWith("'") ? inspected.slice(1, -1) : inspected);
}

type ProcSample = {
  cpuTicks: number;
  gpuNs: number;
  threads: Map<string, { name: string; ticks: number }>;
};
function readProc(pid: number, withThreads: boolean): ProcSample | null {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuTicks = Number(f[11]) + Number(f[12]);
    const clients = new Map<string, number>();
    for (const fd of Deno.readDirSync(`/proc/${pid}/fdinfo`)) {
      let text: string;
      try {
        text = Deno.readTextFileSync(`/proc/${pid}/fdinfo/${fd.name}`);
      } catch {
        continue;
      }
      const gfx = /drm-engine-gfx:\s*(\d+)/.exec(text), id = /drm-client-id:\s*(\d+)/.exec(text);
      if (gfx && id) clients.set(id[1], Number(gfx[1]));
    }
    const threads = new Map<string, { name: string; ticks: number }>();
    if (withThreads) {
      for (const t of Deno.readDirSync(`/proc/${pid}/task`)) {
        try {
          const s = Deno.readTextFileSync(`/proc/${pid}/task/${t.name}/stat`);
          const name = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
          const g = s.slice(s.lastIndexOf(")") + 2).split(" ");
          threads.set(t.name, { name, ticks: Number(g[11]) + Number(g[12]) });
        } catch { /* thread exited */ }
      }
    }
    return { cpuTicks, gpuNs: [...clients.values()].reduce((a, b) => a + b, 0), threads };
  } catch {
    return null;
  }
}

/** SteamVR runs launcher processes under the same paths: keep the one that has used the most CPU. */
function keepBusiest(roles: Map<string, number>, role: string, pid: number): void {
  const current = roles.get(role);
  const ticks = (p: number | undefined) => p == null ? -1 : readProc(p, false)?.cpuTicks ?? -1;
  if (ticks(pid) > ticks(current)) roles.set(role, pid);
}

function findPids(): Map<string, number> {
  const roles = new Map<string, number>();
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    let cmd: string;
    try {
      cmd = Deno.readTextFileSync(`/proc/${e.name}/cmdline`).replaceAll("\0", " ");
    } catch {
      continue;
    }
    const pid = Number(e.name);
    if (/VRChat\.exe/.test(cmd) && !/pressure-vessel|srt-bwrap|steam-launch/.test(cmd)) {
      // The Proton process tree: keep the one using the GPU (the game).
      const s = readProc(pid, false);
      if (s && s.gpuNs > (readProc(roles.get("vrchat") ?? -1, false)?.gpuNs ?? -1)) {
        roles.set("vrchat", pid);
      }
    } else if (/bin\/linux64\/vrcompositor/.test(cmd)) keepBusiest(roles, "vrcompositor", pid);
    else if (/bin\/linux64\/vrserver/.test(cmd)) keepBusiest(roles, "vrserver", pid);
    else if (/petplay\/petplay\.ts/.test(cmd) && /^ppvr|deno/.test(cmd.trim())) {
      roles.set("petplay-main", pid);
    } else if (/petplayChildEntry/.test(cmd)) roles.set(`petplay-child-${pid}`, pid);
  }
  return roles;
}

const options = await message(actors.webxr, "SETVRCDEPTHOPTIONS", {}).catch((e) => ({
  error: String(e),
}));
const depthStatus = actors.vrchatDepth
  ? await message(actors.vrchatDepth, "GETVRCDEPTHSTATUS")
  : null;
const helperId = depthStatus?.gpuHelper?.actor ?? null;
const helperStatus = helperId ? await message(helperId, "__HEALTH__").catch(() => null) : null;
const roles = findPids();
// Name the depth processes from their own reported pids.
for (
  const [role, pid] of [["depth-intake", depthStatus?.pid], [
    "depth-gpu-helper",
    helperStatus?.pid,
  ]] as const
) {
  if (typeof pid === "number") {
    roles.delete(`petplay-child-${pid}`);
    roles.set(role, pid);
  }
}

const readAll = () =>
  new Map([...roles].map(([role, pid]) => [role, readProc(pid, role === "petplay-main")] as const));
const busy: number[] = [];
const busyTimer = setInterval(() => {
  try {
    busy.push(Number(Deno.readTextFileSync("/sys/class/drm/card1/device/gpu_busy_percent")));
  } catch { /* not amdgpu card1 */ }
}, 250);

const decodedA = depthStatus?.decoded ?? 0;
const xA = await webxrSnapshot();
const pA = readAll();
const tA = performance.now();
await new Promise((r) => setTimeout(r, seconds * 1000));
const pB = readAll();
const tB = performance.now();
const xB = await webxrSnapshot();
clearInterval(busyTimer);
const depthB = actors.vrchatDepth ? await message(actors.vrchatDepth, "GETVRCDEPTHSTATUS") : null;
const dt = (tB - tA) / 1000;

const processes: Record<string, { pid: number; cpuPercent: number; gpuPercent: number }> = {};
let mainThreads: { name: string; tid: string; cpuPercent: number }[] = [];
for (const [role, pid] of roles) {
  const a = pA.get(role), b = pB.get(role);
  if (!a || !b) continue;
  processes[role] = {
    pid,
    cpuPercent: round((b.cpuTicks - a.cpuTicks) / CLOCK_TICKS / dt * 100),
    gpuPercent: round((b.gpuNs - a.gpuNs) / 1e9 / dt * 100),
  };
  if (role === "petplay-main") {
    mainThreads = [...b.threads].map(([tid, t]) => ({
      tid,
      name: t.name,
      cpuPercent: round(
        (t.ticks - (a.threads.get(tid)?.ticks ?? t.ticks)) / CLOCK_TICKS / dt * 100,
      ),
    })).filter((t) => t.cpuPercent >= 0.5).sort((x, y) => y.cpuPercent - x.cpuPercent).slice(0, 8);
  }
}
const webxrFrames: Record<string, { msPerFrame: number; perSecond: number }> = {};
for (const key of METRICS) {
  const a = xA[key], b = xB[key];
  if (!a || !b || b.count === a.count) continue;
  webxrFrames[key.replace(/Metric$/, "")] = {
    msPerFrame: round((b.totalMs - a.totalMs) / (b.count - a.count), 3),
    perSecond: round((b.count - a.count) / ((xB.at - xA.at) / 1000)),
  };
}
const record = {
  label,
  at: new Date().toISOString(),
  seconds: round(dt),
  config: {
    webxr: options,
    lease: depthStatus?.lease ?? null,
    gpuHelper: depthStatus?.gpuHelper ?? null,
    calibration: depthStatus?.calibration?.mode ?? null,
  },
  depthFramesPerSecond: depthB ? round((depthB.decoded - decodedA) / dt) : null,
  overlay: {
    framesPerSecond: webxrFrames.raylibHostPrep?.perSecond ?? null,
    droppedPresents: (xB.dropped ?? 0) - (xA.dropped ?? 0),
  },
  gpuBusyPercent: busy.length ? round(busy.reduce((a, b) => a + b, 0) / busy.length) : null,
  processes,
  mainThreads,
  webxrFrames,
};
Deno.mkdirSync(outDir, { recursive: true });
const path = `${outDir}/${label}.json`;
Deno.writeTextFileSync(path, JSON.stringify(record, null, 2));
print(record);
console.log(`\nwritten ${path}`);

function round(v: number, digits = 1): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function print(r: typeof record): void {
  console.log(
    `${r.label}  ${r.at}  ${r.seconds}s  depth ${r.depthFramesPerSecond} fps  overlay ` +
      `${r.overlay.framesPerSecond} fps, ${r.overlay.droppedPresents} dropped  GPU busy ${r.gpuBusyPercent}%`,
  );
  console.log("\nprocess              cpu%    gpu%");
  for (
    const [role, p] of Object.entries(r.processes).sort((a, b) => b[1].cpuPercent - a[1].cpuPercent)
  ) {
    console.log(
      `${role.padEnd(20)} ${String(p.cpuPercent).padStart(5)}  ${String(p.gpuPercent).padStart(6)}`,
    );
  }
  console.log(
    "\nmain threads: " + r.mainThreads.map((t) => `${t.name} ${t.cpuPercent}%`).join(", "),
  );
  console.log("\nwebxr stage         ms/frame  per s");
  for (const [k, v] of Object.entries(r.webxrFrames)) {
    console.log(
      `${k.padEnd(20)} ${String(v.msPerFrame).padStart(7)}  ${String(v.perSecond).padStart(5)}`,
    );
  }
}

function compare(paths: string[]): void {
  const [a, b] = paths.map((p) => JSON.parse(Deno.readTextFileSync(p)));
  const row = (name: string, x: unknown, y: unknown) =>
    console.log(
      `${name.padEnd(28)} ${String(x ?? "-").padStart(8)} ${String(y ?? "-").padStart(8)}`,
    );
  console.log(`${"".padEnd(28)} ${String(a.label).padStart(8)} ${String(b.label).padStart(8)}`);
  row("depth fps", a.depthFramesPerSecond, b.depthFramesPerSecond);
  row("overlay fps", a.overlay.framesPerSecond, b.overlay.framesPerSecond);
  row("dropped presents", a.overlay.droppedPresents, b.overlay.droppedPresents);
  row("GPU busy %", a.gpuBusyPercent, b.gpuBusyPercent);
  for (const role of new Set([...Object.keys(a.processes), ...Object.keys(b.processes)])) {
    row(`${role} cpu%`, a.processes[role]?.cpuPercent, b.processes[role]?.cpuPercent);
    row(`${role} gpu%`, a.processes[role]?.gpuPercent, b.processes[role]?.gpuPercent);
  }
  for (const k of new Set([...Object.keys(a.webxrFrames), ...Object.keys(b.webxrFrames)])) {
    row(`${k} ms/frame`, a.webxrFrames[k]?.msPerFrame, b.webxrFrames[k]?.msPerFrame);
  }
}
