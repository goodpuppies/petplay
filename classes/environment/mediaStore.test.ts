import { assertEquals } from "@std/assert";
import { nowPlayingLabel, parsePlayerctlLine } from "./mediaStore.ts";

Deno.test("parsePlayerctlLine reads player, status, artist and title", () => {
  assertEquals(parsePlayerctlLine("AIMP\tPlaying\tpolyscream\tdepthcharge"), {
    player: "AIMP",
    playing: true,
    artist: "polyscream",
    title: "depthcharge",
  });
  assertEquals(parsePlayerctlLine("spotify\tPaused\t\tA\tB")?.title, "A\tB");
  assertEquals(parsePlayerctlLine("spotify\tPaused\t\tA\tB")?.playing, false);
});

Deno.test("parsePlayerctlLine: a blank line means no player", () => {
  assertEquals(parsePlayerctlLine(""), null);
  assertEquals(parsePlayerctlLine("  "), null);
});

Deno.test("nowPlayingLabel joins what the player gave", () => {
  const base = { player: "mpv", playing: true, artist: "", title: "" };
  assertEquals(nowPlayingLabel({ ...base, artist: "A", title: "T" }), "A · T");
  assertEquals(nowPlayingLabel({ ...base, title: "clip.mkv" }), "clip.mkv");
  assertEquals(nowPlayingLabel(base), "mpv");
});
