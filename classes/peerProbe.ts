/**
 * Coop dev pairing diagnostics: what one PetPlay tells a trusted peer about itself, and how two
 * of those snapshots are compared end to end (`deno task coop:verify`, utils/coop-verify.ts).
 *
 * A probe is read-only and answered only to a trusted `vrcPeers` actor whose user has Settings →
 * Install → Peer Code Patches on (the same opt-in as live code patches, which can do far more).
 * It reports the build, the network path of every iroh link, the peers it sees, what it shares
 * and the poses it shows of others' displays, and the last error lines of its log.
 */
import { join } from "@std/path";
import type { BuildInfo } from "./buildInfo.ts";
import type { IrohConnectionInfo } from "./irohCarrier.ts";
import type { SharedDisplayWorldPose } from "./vrcOriginTransform.ts";
import { checkoutRoot, logsDir } from "./appPaths.ts";

export type ProbeSharedDisplay = {
  kind?: "monitor" | "window";
  name: string;
  windowId?: string;
  worldPose?: SharedDisplayWorldPose;
};

export type ProbeViewedDisplay = {
  key: string;
  name: string;
  kind: "monitor" | "window";
  /** The sharer's `displayShare` actor. */
  source: string;
  monitor?: number;
  windowId?: string;
  worldPose: SharedDisplayWorldPose | null;
};

export type PeerProbe = {
  at: number;
  displayName: string | null;
  vrcUserId: string | null;
  build: BuildInfo;
  updateChannel: string;
  acceptPeerPatches: boolean;
  /** This machine's direct iroh endpoint id (what the other side's links name as `peer`). */
  directId: string | null;
  links: IrohConnectionInfo[] | null;
  peers: Array<{ displayName: string; actorId: string; trust: string; inInstance: boolean }>;
  sharing: { actor: string | null; shared: ProbeSharedDisplay[] } | null;
  viewing: ProbeViewedDisplay[] | null;
  logErrors: string[];
};

export type PeerProbeReply = { ok: true; probe: PeerProbe } | { ok: false; error: string };

const ERROR_LINE = /\b(error|exception|panic|fatal|uncaught|failed|timed out)\b/i;

/** The last `max` error-looking lines of this run's log (release `current.log`, checkout `logs/`). */
export function recentLogErrors(max = 20): string[] {
  const path = currentLogPath();
  if (!path) return [];
  try {
    const file = Deno.openSync(path, { read: true });
    try {
      const size = file.statSync().size;
      const length = Math.min(size, 512 * 1024);
      file.seekSync(size - length, Deno.SeekMode.Start);
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const n = file.readSync(bytes.subarray(read));
        if (n == null || n === 0) break;
        read += n;
      }
      return new TextDecoder().decode(bytes.subarray(0, read)).split("\n")
        .filter((line) => ERROR_LINE.test(line))
        .slice(-max)
        .map((line) => line.length > 300 ? `${line.slice(0, 299)}…` : line);
    } finally {
      file.close();
    }
  } catch {
    return [];
  }
}

function currentLogPath(): string | null {
  const root = checkoutRoot();
  if (root == null) return join(logsDir(), "current.log");
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const entry of Deno.readDirSync(join(root, "logs"))) {
      if (!/^petplay-.*\.log$/.test(entry.name)) continue;
      const path = join(root, "logs", entry.name);
      const mtime = Deno.statSync(path).mtime?.getTime() ?? 0;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return null;
  }
  return newest?.path ?? null;
}

// ---------------------------------------------------------------------------------------------
// Comparing two machines

export type CheckStatus = "pass" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

const RTT_WARN_MS = 150;
/** Viewers and the sharer should agree on a still display to about a centimetre. */
const POSE_WARN_M = 0.03;
const POSE_FAIL_M = 0.15;

function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

function linkTo(probe: PeerProbe, peerDirectId: string | null): IrohConnectionInfo | null {
  if (!probe.links || !peerDirectId) return null;
  const direct = probe.links.filter((l) => l.peer === peerDirectId && l.tier === "direct");
  return direct.find((l) => l.path?.path === "direct") ?? direct[0] ?? null;
}

function describeLink(link: IrohConnectionInfo | null): string {
  if (!link) return "no direct-tier connection";
  if (!link.path) return "connected, path not reported yet (petplay-media without path events?)";
  return `${link.path.path} via ${link.path.remote}, rtt ${link.path.rttMs} ms (open: ${
    link.path.open.join(" ") || "none"
  })`;
}

function poseDelta(a: SharedDisplayWorldPose, b: SharedDisplayWorldPose) {
  const d = a.position.map((v, i) => v - b.position[i]!);
  const position = Math.hypot(d[0]!, d[1]!, d[2]!);
  const rotation = Math.max(...a.rotation.map((v, i) => {
    const diff = Math.abs(v - b.rotation[i]!) % (2 * Math.PI);
    return Math.min(diff, 2 * Math.PI - diff);
  }));
  return { position, rotationDeg: rotation * 180 / Math.PI };
}

/** How the displays `sharer` shares look on `viewer`: pose agreement per display. */
export function compareSharedPoses(sharer: PeerProbe, viewer: PeerProbe, who: string): Check[] {
  const actor = sharer.sharing?.actor;
  const shared = (sharer.sharing?.shared ?? []).filter((s) => s.worldPose);
  if (!actor || shared.length === 0) return [];
  const viewed = (viewer.viewing ?? []).filter((v) => v.source === actor && v.worldPose);
  if (viewed.length === 0) {
    return [{
      name: `${who} display poses`,
      status: "warn",
      detail:
        `${shared.length} shared display(s) with a pose, none shown with a pose on the other side`,
    }];
  }
  return viewed.map((view) => {
    const candidates = shared.filter((s) =>
      (s.kind ?? "monitor") === view.kind &&
      (view.kind !== "window" || s.windowId === view.windowId)
    );
    const scored = candidates.map((s) => ({ s, delta: poseDelta(s.worldPose!, view.worldPose!) }))
      .sort((a, b) => a.delta.position - b.delta.position);
    const best = scored[0];
    if (!best) {
      return {
        name: `${who} ${view.name}`,
        status: "warn" as const,
        detail: "no matching shared display",
      };
    }
    const age = Math.abs(best.s.worldPose!.updatedAt - view.worldPose!.updatedAt);
    const status: CheckStatus = best.delta.position > POSE_FAIL_M
      ? "fail"
      : best.delta.position > POSE_WARN_M || best.delta.rotationDeg > 2
      ? "warn"
      : "pass";
    return {
      name: `${who} ${view.name} pose`,
      status,
      detail: `${(best.delta.position * 100).toFixed(1)} cm, ${
        best.delta.rotationDeg.toFixed(1)
      }° apart (${best.s.name}; pose times ${age} ms apart)`,
    };
  });
}

/** Every check between this machine (`local`) and one trusted peer (`remote`). */
export function comparePeers(local: PeerProbe, remote: PeerProbe): Check[] {
  const name = remote.displayName ?? "peer";
  const checks: Check[] = [];
  checks.push(
    sameCommit(local.build.commit, remote.build.commit)
      ? { name: "same build", status: "pass", detail: `${local.build.version} on both` }
      : {
        name: "same build",
        status: "warn",
        detail:
          `here ${local.build.version} (${
            local.build.commit?.slice(0, 7) ?? "?"
          }, ${local.updateChannel}), ${name} ${remote.build.version} (${
            remote.build.commit?.slice(0, 7) ?? "?"
          }, ${remote.updateChannel}): put both on one channel, ` +
          `or peer-patch --since ${remote.build.commit?.slice(0, 7) ?? "<their commit>"}`,
      },
  );
  checks.push({
    name: "peer patches",
    status: remote.acceptPeerPatches ? "pass" : "warn",
    detail: remote.acceptPeerPatches ? `${name} accepts them` : `${name} has Peer Code Patches off`,
  });
  for (
    const [side, probe, otherId] of [
      ["here", local, remote.directId],
      [name, remote, local.directId],
    ] as const
  ) {
    const link = linkTo(probe, otherId);
    const status: CheckStatus = !link
      ? "fail"
      : link.path?.path === "direct"
      ? (link.path.rttMs > RTT_WARN_MS ? "warn" : "pass")
      : "warn";
    checks.push({ name: `link (${side})`, status, detail: describeLink(link) });
  }
  checks.push(...compareSharedPoses(local, remote, `${name} sees my`));
  checks.push(...compareSharedPoses(remote, local, `I see ${name}'s`));
  for (const [side, probe] of [["here", local], [name, remote]] as const) {
    checks.push({
      name: `log errors (${side})`,
      status: probe.logErrors.length === 0 ? "pass" : "warn",
      detail: probe.logErrors.length === 0
        ? "none recently"
        : `${probe.logErrors.length} recent, last: ${probe.logErrors.at(-1)}`,
    });
  }
  return checks;
}
