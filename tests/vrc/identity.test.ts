import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  instancePreimageProof,
  loadOrCreateIdentity,
  randomNonce,
  signChallenge,
  verifyChallenge,
  verifyInstancePreimageProof,
  vrcInstanceTopic,
  vrcInstanceTopicKey,
  VrcTrustStore,
} from "../../classes/vrc/identity.ts";

Deno.test("Ed25519 identity persists across loads and signs/verifies challenges", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "petplay-vrcid-" });
  try {
    const idPath = join(dir, "identity.json");
    const id1 = await loadOrCreateIdentity(idPath);
    const id2 = await loadOrCreateIdentity(idPath);
    assertEquals(id1.publicKey, id2.publicKey);
    assertEquals(id1.fingerprint, id2.fingerprint);

    const instanceId = "wrld_abc:123~hidden(usr_1)~region(eu)~nonce(secret)";
    const topic = await vrcInstanceTopic(instanceId);
    const topicKey = await vrcInstanceTopicKey(instanceId);
    assertEquals(topic.startsWith("vrc-inst-"), true);
    assertEquals(topic.includes("wrld_abc"), false);
    assertEquals(topicKey.length, 43); // 32 bytes base64url without padding
    assertNotEquals(topicKey, topic);
    assertEquals(topicKey, await vrcInstanceTopicKey(instanceId));

    const nonce = randomNonce();
    const proof = await instancePreimageProof({
      instanceId,
      from: "vrcPeers@bob",
      to: "vrcPeers@alice",
      nonce,
    });
    assertEquals(
      await verifyInstancePreimageProof({
        proof,
        instanceId,
        from: "vrcPeers@bob",
        to: "vrcPeers@alice",
        nonce,
      }),
      true,
    );
    // Knowing only the topic hash, reversing direction, or changing nonce must fail.
    assertEquals(
      await verifyInstancePreimageProof({
        proof,
        instanceId: topic,
        from: "vrcPeers@bob",
        to: "vrcPeers@alice",
        nonce,
      }),
      false,
    );
    assertEquals(
      await verifyInstancePreimageProof({
        proof,
        instanceId,
        from: "vrcPeers@alice",
        to: "vrcPeers@bob",
        nonce,
      }),
      false,
    );
    assertEquals(
      await verifyInstancePreimageProof({
        proof,
        instanceId,
        from: "vrcPeers@bob",
        to: "vrcPeers@alice",
        nonce: randomNonce(),
      }),
      false,
    );

    const sig = await signChallenge(id1, {
      actorId: "vrcPeers@alice",
      vrcUserId: "usr_alice",
      instanceId,
      nonce,
    });

    assertEquals(
      await verifyChallenge({
        publicKey: id1.publicKey,
        signature: sig,
        actorId: "vrcPeers@alice",
        vrcUserId: "usr_alice",
        instanceId,
        nonce,
      }),
      true,
    );

    // Wrong nonce, wrong instanceId (e.g. only the topic hash), or wrong userId must fail.
    assertEquals(
      await verifyChallenge({
        publicKey: id1.publicKey,
        signature: sig,
        actorId: "vrcPeers@alice",
        vrcUserId: "usr_alice",
        instanceId,
        nonce: randomNonce(),
      }),
      false,
    );
    assertEquals(
      await verifyChallenge({
        publicKey: id1.publicKey,
        signature: sig,
        actorId: "vrcPeers@alice",
        vrcUserId: "usr_alice",
        instanceId: topic,
        nonce,
      }),
      false,
    );
    assertEquals(
      await verifyChallenge({
        publicKey: id1.publicKey,
        signature: sig,
        actorId: "vrcPeers@alice",
        vrcUserId: "usr_mallory",
        instanceId,
        nonce,
      }),
      false,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("VrcTrustStore enforces TOFU pinning, mismatch detection, and force re-trust", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "petplay-vrctrust-" });
  try {
    const trustPath = join(dir, "vrc-trust.json");
    const bob1 = await loadOrCreateIdentity(join(dir, "bob1.json"));
    const bob2 = await loadOrCreateIdentity(join(dir, "bob2.json"));
    assertNotEquals(bob1.publicKey, bob2.publicKey);

    const store = new VrcTrustStore(trustPath);
    assertEquals(store.evaluate("usr_bob", bob1.publicKey, false), "not_in_instance");
    assertEquals(store.evaluate("usr_bob", bob1.publicKey, true), "pending");

    store.trust({
      userId: "usr_bob",
      publicKey: bob1.publicKey,
      fingerprint: bob1.fingerprint,
      displayName: "Bob",
    });

    // Reload from disk to verify persistence.
    const reloaded = new VrcTrustStore(trustPath);
    assertEquals(reloaded.evaluate("usr_bob", bob1.publicKey, true), "trusted");
    assertEquals(reloaded.evaluate("usr_bob", bob2.publicKey, true), "key_mismatch");
    assertEquals(reloaded.evaluate("usr_bob", bob1.publicKey, false), "not_in_instance");

    assertThrows(() =>
      reloaded.trust({
        userId: "usr_bob",
        publicKey: bob2.publicKey,
        fingerprint: bob2.fingerprint,
        displayName: "Bob",
      })
    );

    reloaded.trust(
      {
        userId: "usr_bob",
        publicKey: bob2.publicKey,
        fingerprint: bob2.fingerprint,
        displayName: "Bob",
      },
      { force: true },
    );
    assertEquals(reloaded.evaluate("usr_bob", bob2.publicKey, true), "trusted");

    assertEquals(reloaded.untrust("usr_bob"), true);
    assertEquals(reloaded.evaluate("usr_bob", bob2.publicKey, true), "pending");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
