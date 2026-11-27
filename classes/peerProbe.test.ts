import { assertEquals } from "@std/assert";
import { comparePeers, type PeerProbe } from "./peerProbe.ts";

const pose = (x: number, at = 1000) => ({
  position: [x, 1, 2] as [number, number, number],
  rotation: [0, 0.5, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  updatedAt: at,
});

function probe(over: Partial<PeerProbe>): PeerProbe {
  return {
    at: 0,
    displayName: "me",
    vrcUserId: "usr_me",
    build: { version: "v0.0.37", commit: "a".repeat(40), built: null, mode: "production" },
    updateChannel: "stable",
    acceptPeerPatches: true,
    directId: "me-direct",
    links: [],
    peers: [],
    sharing: null,
    viewing: null,
    logErrors: [],
    ...over,
  };
}

const byName = (checks: { name: string; status: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c.status]));

Deno.test("comparePeers: same build, direct link and agreeing poses pass", () => {
  const link = (peer: string) => ({
    conn: 1,
    peer,
    tier: "direct" as const,
    path: { path: "direct" as const, remote: "1.2.3.4:5", rttMs: 40, open: [], since: 0 },
  });
  const local = probe({
    links: [link("friend-direct")],
    sharing: { actor: "displayShare@me", shared: [{ name: "DP-1", worldPose: pose(1) }] },
  });
  const remote = probe({
    displayName: "friend",
    directId: "friend-direct",
    links: [link("me-direct")],
    viewing: [{
      key: "m:0",
      name: "me1",
      kind: "monitor",
      source: "displayShare@me",
      monitor: 0,
      worldPose: pose(1.005, 1100),
    }],
  });
  const checks = byName(comparePeers(local, remote));
  assertEquals(checks["same build"], "pass");
  assertEquals(checks["link (here)"], "pass");
  assertEquals(checks["link (friend)"], "pass");
  assertEquals(checks["friend sees my me1 pose"], "pass");
});

Deno.test("comparePeers: relay links, build drift and pose disagreement are reported", () => {
  const relay = (peer: string) => ({
    conn: 1,
    peer,
    tier: "direct" as const,
    path: { path: "relay" as const, remote: "https://relay", rttMs: 240, open: [], since: 0 },
  });
  const local = probe({
    links: [relay("friend-direct")],
    sharing: { actor: "displayShare@me", shared: [{ name: "DP-1", worldPose: pose(1) }] },
  });
  const remote = probe({
    displayName: "friend",
    directId: "friend-direct",
    build: { version: "v0.0.35", commit: "b".repeat(40), built: null, mode: "production" },
    links: [],
    acceptPeerPatches: false,
    viewing: [{
      key: "m:0",
      name: "me1",
      kind: "monitor",
      source: "displayShare@me",
      worldPose: pose(1.3),
    }],
    logErrors: ["x failed"],
  });
  const checks = byName(comparePeers(local, remote));
  assertEquals(checks["same build"], "warn");
  assertEquals(checks["peer patches"], "warn");
  assertEquals(checks["link (here)"], "warn");
  assertEquals(checks["link (friend)"], "fail");
  assertEquals(checks["friend sees my me1 pose"], "fail");
  assertEquals(checks["log errors (friend)"], "warn");
});
