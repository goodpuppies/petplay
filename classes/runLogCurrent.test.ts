import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { archiveCurrentLog } from "./runLog.ts";

Deno.test("each run logs to current.log; the previous one is kept under its start time", () => {
  const directory = Deno.makeTempDirSync();
  try {
    assertEquals(archiveCurrentLog(directory), join(directory, "current.log"), "first run");
    Deno.writeTextFileSync(
      join(directory, "current.log"),
      "[petplay log] x\nstarted 2026-11-12T18:05:05.170Z\n",
    );
    assertEquals(archiveCurrentLog(directory), join(directory, "current.log"));
    assertEquals(
      [...Deno.readDirSync(directory)].map((e) => e.name),
      ["petplay-2026-11-12T18-05-05-170Z.log"],
    );
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});
