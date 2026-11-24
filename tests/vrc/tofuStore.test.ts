import { assertEquals } from "@std/assert";
import { createVrcTofuStore } from "../../classes/environment/vrcTofuStore.ts";

Deno.test("vrcTofuStore filters to in-instance pending/mismatch peers and remembers session dismissals", () => {
  const store = createVrcTofuStore();
  let notifications = 0;
  const unsub = store.subscribe(() => notifications++);

  store.setPeers([
    {
      actorId: "vrcPeers@1",
      vrcUserId: "usr_alice",
      displayName: "Alice",
      fingerprint: "aaaa-bbbb-cccc",
      inInstance: true,
      trust: "trusted",
    },
    {
      actorId: "vrcPeers@2",
      vrcUserId: "usr_bob",
      displayName: "Bob",
      fingerprint: "1111-2222-3333",
      inInstance: true,
      trust: "pending",
    },
    {
      actorId: "vrcPeers@3",
      vrcUserId: "usr_charlie",
      displayName: "Charlie",
      fingerprint: "4444-5555-6666",
      inInstance: false,
      trust: "not_in_instance",
    },
  ]);

  assertEquals(store.prompts().length, 1);
  assertEquals(store.prompts()[0].displayName, "Bob");
  assertEquals(notifications, 1);

  // Identical update should not emit a redundant notification.
  store.setPeers([
    {
      actorId: "vrcPeers@2",
      vrcUserId: "usr_bob",
      displayName: "Bob",
      fingerprint: "1111-2222-3333",
      inInstance: true,
      trust: "pending",
    },
  ]);
  assertEquals(notifications, 1);

  // Dismissing Bob hides him across subsequent updates with the same fingerprint.
  store.dismiss("usr_bob", "1111-2222-3333");
  assertEquals(store.prompts().length, 0);
  store.setPeers([
    {
      actorId: "vrcPeers@2",
      vrcUserId: "usr_bob",
      displayName: "Bob",
      fingerprint: "1111-2222-3333",
      inInstance: true,
      trust: "pending",
    },
  ]);
  assertEquals(store.prompts().length, 0);

  // A new fingerprint (e.g. key_mismatch) still prompts even though the old one was dismissed.
  store.setPeers([
    {
      actorId: "vrcPeers@2",
      vrcUserId: "usr_bob",
      displayName: "Bob",
      fingerprint: "9999-8888-7777",
      inInstance: true,
      trust: "key_mismatch",
      pinnedFingerprint: "1111-2222-3333",
    },
  ]);
  assertEquals(store.prompts().length, 1);
  assertEquals(store.prompts()[0].trust, "key_mismatch");
  assertEquals(store.prompts()[0].pinnedFingerprint, "1111-2222-3333");

  unsub();
});
