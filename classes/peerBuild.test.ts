import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PEER_BUILD_PIECE_BYTES, PeerBuildReceiver } from "./peerBuild.ts";
import { indexFile } from "./updateChunks.ts";
import { installFile } from "./installer.ts";
import { petplayRemotePolicy } from "./remotePolicy.ts";

function bytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function base64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function setup() {
  const dir = await Deno.makeTempDir();
  const oldBuild = bytes(3_000_000, 1);
  const newBuild = new Uint8Array(oldBuild.length + 5000);
  newBuild.set(oldBuild.subarray(0, 1_000_000));
  newBuild.set(bytes(5000, 9), 1_000_000);
  newBuild.set(oldBuild.subarray(1_000_000), 1_005_000);
  const target = join(dir, "petplay");
  const sent = join(dir, "sent");
  await Deno.writeFile(target, oldBuild);
  await Deno.writeFile(sent, newBuild);
  const receiver = new PeerBuildReceiver({
    targetPath: () => target,
    localSources: () => [target],
  });
  return { dir, target, sent, newBuild, receiver };
}

Deno.test("a peer build arrives as only its missing chunks and installs through the installer", async () => {
  const { dir, target, sent, newBuild, receiver } = await setup();
  try {
    const index = await indexFile(sent);
    const plan = await receiver.offer({
      id: "t1",
      build: { version: "test", commit: null, built: null, mode: "production" },
      target: Deno.build.target,
      index,
    });
    assert(plan.fetchBytes < newBuild.length / 4, `fetch ${plan.fetchBytes}`);
    for (const range of plan.ranges) {
      for (let offset = range.start; offset < range.end; offset += PEER_BUILD_PIECE_BYTES) {
        const end = Math.min(range.end, offset + PEER_BUILD_PIECE_BYTES);
        await receiver.piece({ id: "t1", offset, data: base64(newBuild.subarray(offset, end)) });
      }
    }
    const result = await receiver.commit(
      "t1",
      (staging, sha256) =>
        installFile(staging, {
          targetPath: target,
          expectedSha256: sha256,
          register: false,
          skipSmokeTest: true,
        }),
    );
    assertEquals(result.action, "install-file");
    assertEquals(await Deno.readFile(target), newBuild);
    assert(
      [...Deno.readDirSync(dir)].every((e) => !e.name.endsWith(".peer")),
      "staging file left behind",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a peer build refuses bytes it did not ask for, a wrong target, and an incomplete transfer", async () => {
  const { dir, target, sent, receiver } = await setup();
  try {
    const index = await indexFile(sent);
    await assertRejects(() =>
      receiver.offer({
        id: "x",
        build: { version: "t", commit: null, built: null, mode: "production" },
        target: "riscv64-unknown-none",
        index,
      })
    );
    const plan = await receiver.offer({
      id: "t2",
      build: { version: "t", commit: null, built: null, mode: "production" },
      target: Deno.build.target,
      index,
    });
    const outside = plan.ranges[0]!.start === 0 ? index.size - 10 : 0;
    await assertRejects(() =>
      receiver.piece({ id: "t2", offset: outside, data: base64(new Uint8Array(10)) })
    );
    const before = await Deno.readFile(target);
    await assertRejects(
      () =>
        receiver.commit(
          "t2",
          (staging, sha256) =>
            installFile(staging, {
              targetPath: target,
              expectedSha256: sha256,
              register: false,
              skipSmokeTest: true,
            }),
        ),
      Error,
      "does not match",
    );
    assertEquals(await Deno.readFile(target), before);
    assertEquals(receiver.active, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trusted peers may evaluate code only with Peer Code Patches on", async () => {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("PETPLAY_SETTINGS_PATH");
  try {
    const settings = join(dir, "settings.json");
    await Deno.writeTextFile(settings, JSON.stringify({ acceptPeerPatches: false }));
    Deno.env.set("PETPLAY_SETTINGS_PATH", settings);
    const policy = petplayRemotePolicy();
    const direct = { tier: "direct" } as Parameters<typeof policy>[1];
    const message = (to: string, type: string) =>
      ({ address: { to }, type }) as Parameters<typeof policy>[0];
    assertEquals(policy(message("webxr@1", "EVALJS"), direct), false);
    assertEquals(policy(message("displayShare@1", "DESCRIBE"), direct), true);
    assertEquals(policy(message("vrcPeers@1", "PEERCALL"), direct), false);
    assertEquals(
      policy(
        message("vrcPeers@1", "PEERBUILDOFFER"),
        { tier: "discovery" } as Parameters<typeof policy>[1],
      ),
      false,
    );
  } finally {
    if (previous == null) Deno.env.delete("PETPLAY_SETTINGS_PATH");
    else Deno.env.set("PETPLAY_SETTINGS_PATH", previous);
    await Deno.remove(dir, { recursive: true });
  }
});
