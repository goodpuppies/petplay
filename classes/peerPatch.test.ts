import { assertEquals, assertThrows } from "@std/assert";
import { peerPatchesAccepted, resolvePatchModules, summarizePeerPatch } from "./peerPatch.ts";
import { petplayRemotePolicy } from "./remotePolicy.ts";

const root = new URL("file:///tmp/deno-compile-petplay/");

Deno.test("a patch path maps onto this machine's module root", () => {
  assertEquals(
    resolvePatchModules([{ path: "classes/environment/scene.tsx", source: "x" }], root),
    [{ url: "file:///tmp/deno-compile-petplay/classes/environment/scene.tsx", source: "x" }],
  );
});

Deno.test("a patch cannot address anything outside the module tree", () => {
  for (
    const path of [
      "../etc/passwd.ts",
      "/abs/x.ts",
      "classes/../../x.ts",
      "classes//x.ts",
      "C:/x.ts",
      "classes\\x.ts",
      "resources/petplay.png",
      "file:///x.ts",
    ]
  ) {
    assertThrows(() => resolvePatchModules([{ path, source: "" }], root), Error, undefined, path);
  }
  assertThrows(() => resolvePatchModules([], root));
  assertThrows(() => resolvePatchModules(null, root));
});

Deno.test("patches are refused unless the setting is on", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/settings.json`;
  assertEquals(peerPatchesAccepted(path), false);
  Deno.writeTextFileSync(path, JSON.stringify({ acceptPeerPatches: true }));
  assertEquals(peerPatchesAccepted(path), true);
  Deno.writeTextFileSync(path, JSON.stringify({ acceptPeerPatches: false }));
  assertEquals(peerPatchesAccepted(path), false);
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("remote HOTPATCH is refused on every tier; PEERPATCH only once trusted", () => {
  const policy = petplayRemotePolicy();
  const message = (to: string, type: string) => ({ address: { to }, type }) as never;
  for (const tier of ["discovery", "direct"] as const) {
    const connection = { tier } as never;
    assertEquals(policy(message("webxr@1", "HOTPATCH"), connection), false);
    assertEquals(policy(message("vrcPeers@1", "SENDPEERPATCH"), connection), false);
  }
  assertEquals(policy(message("vrcPeers@1", "PEERPATCH"), { tier: "discovery" } as never), false);
  assertEquals(policy(message("vrcPeers@1", "PEERPATCH"), { tier: "direct" } as never), true);
});

Deno.test("the summary names patched functions and refusals", () => {
  assertEquals(
    summarizePeerPatch([
      { actor: "webxr", status: "patched", functions: ["tick"] },
      { actor: "main", status: "absent" },
      { actor: "displayShare", status: "structural", detail: "displayShare.ts: top-level code changed" },
    ]),
    "patched webxr (tick) | displayShare: structural (displayShare.ts: top-level code changed)",
  );
  assertEquals(summarizePeerPatch([{ actor: "main", status: "absent" }]), "no running actor loaded these modules");
});
