import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { VrcLogParser, VrcLogWatcher } from "../../classes/vrc/logParser.ts";

const SAMPLE_LOG = `
2026.11.16 22:46:34 Debug      -  [Authentication - ABC] Preforming post login checks for ElectronicFreezer (usr_7075a095-61cf-4db6-9a7d-5fc91445ff44)
2026.11.16 22:46:37 Debug      -  [Behaviour] Entering Room: Restlia -twilight-
2026.11.16 22:46:37 Debug      -  [Behaviour] Joining wrld_3f1820a2-9877-4524-82a7-f1dfac0d2e11:32598~hidden(usr_7075a095-61cf-4db6-9a7d-5fc91445ff44)~region(eu)
2026.11.16 22:46:50 Debug      -  [Behaviour] OnPlayerJoined ElectronicFreezer (usr_7075a095-61cf-4db6-9a7d-5fc91445ff44)
2026.11.16 22:46:55 Debug      -  [Behaviour] OnPlayerJoined ItsPeach (usr_7c74435e-ba5d-4ee5-b2c1-dd6424e74d43)
`;

Deno.test("VrcLogParser parses auth, room, instance, and player join/leave", () => {
  const parser = new VrcLogParser();
  assertEquals(parser.feedText(SAMPLE_LOG), true);
  assertEquals(parser.self, {
    userId: "usr_7075a095-61cf-4db6-9a7d-5fc91445ff44",
    displayName: "ElectronicFreezer",
  });
  assertEquals(parser.worldName, "Restlia -twilight-");
  assertEquals(
    parser.instanceId,
    "wrld_3f1820a2-9877-4524-82a7-f1dfac0d2e11:32598~hidden(usr_7075a095-61cf-4db6-9a7d-5fc91445ff44)~region(eu)",
  );
  assertEquals(parser.players().length, 2);
  assertEquals(parser.hasPlayer("usr_7c74435e-ba5d-4ee5-b2c1-dd6424e74d43"), true);

  parser.feedLine(
    "2026.11.16 22:47:10 Debug      -  [Behaviour] OnPlayerLeft ItsPeach (usr_7c74435e-ba5d-4ee5-b2c1-dd6424e74d43)",
  );
  assertEquals(parser.hasPlayer("usr_7c74435e-ba5d-4ee5-b2c1-dd6424e74d43"), false);
  assertEquals(parser.players().length, 1);

  parser.feedLine("2026.11.16 22:47:33 Debug      -  [Behaviour] OnLeftRoom");
  assertEquals(parser.instanceId, null);
  assertEquals(parser.worldName, null);
  assertEquals(parser.players().length, 0);
  // Local user stays known across room changes.
  assertEquals(parser.self?.userId, "usr_7075a095-61cf-4db6-9a7d-5fc91445ff44");
});

Deno.test("VrcLogWatcher reads existing log from start, tails appends, and handles rotation", () => {
  const dir = Deno.makeTempDirSync({ prefix: "petplay-vrclog-" });
  try {
    const log1 = join(dir, "output_log_2026-11-20_10-00-00.txt");
    Deno.writeTextFileSync(log1, SAMPLE_LOG);

    const watcher = new VrcLogWatcher({ logDir: dir });
    assertEquals(watcher.poll(), true);
    assertEquals(watcher.state.worldName, "Restlia -twilight-");
    assertEquals(watcher.state.players.length, 2);

    // No new bytes -> no change.
    assertEquals(watcher.poll(), false);

    // Partial line followed by completion.
    Deno.writeTextFileSync(
      log1,
      "2026.11.20 10:01:00 Debug      -  [Behaviour] OnPlayerJoined Alice",
      { append: true },
    );
    assertEquals(watcher.poll(), false);
    Deno.writeTextFileSync(
      log1,
      " (usr_11111111-1111-1111-1111-111111111111)\n",
      { append: true },
    );
    assertEquals(watcher.poll(), true);
    assertEquals(watcher.hasPlayer("usr_11111111-1111-1111-1111-111111111111"), true);

    // Rotation to a newer log file resets state.
    const log2 = join(dir, "output_log_2026-11-20_11-00-00.txt");
    Deno.writeTextFileSync(
      log2,
      "2026.11.20 11:00:01 Debug      -  User Authenticated: NewUser (usr_22222222-2222-2222-2222-222222222222)\n",
    );
    assertEquals(watcher.poll(), true);
    assertEquals(watcher.state.self?.userId, "usr_22222222-2222-2222-2222-222222222222");
    assertEquals(watcher.state.instanceId, null);
    assertEquals(watcher.state.players.length, 0);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
