import { assert, assertEquals } from "@std/assert";
import { VrcLogParser } from "./vrc/logParser.ts";
import { parsePeerNodeArgs, peerNodeUserId, synthesizedVrcLog } from "./peerNode.ts";

function parse(log: string): VrcLogParser {
  const parser = new VrcLogParser();
  for (const line of log.split("\n")) parser.feedLine(line);
  return parser;
}

Deno.test("two peer nodes put themselves in the same synthesized VRChat instance", async () => {
  const a = parse(await synthesizedVrcLog("linux-box", ["win-box"], "t1"));
  const b = parse(await synthesizedVrcLog("win-box", ["linux-box"], "t1"));
  assertEquals(a.instanceId, b.instanceId);
  assert(a.instanceId);
  assertEquals(a.self?.userId, await peerNodeUserId("linux-box"));
  assertEquals(b.self?.displayName, "win-box");
  assertEquals(a.players().map((p) => p.displayName).sort(), ["linux-box", "win-box"]);
  const other = parse(await synthesizedVrcLog("linux-box", ["win-box"], "t2"));
  assert(other.instanceId !== a.instanceId);
});

Deno.test("--peer-node arguments", () => {
  assertEquals(parsePeerNodeArgs(["dev"]), null);
  const options = parsePeerNodeArgs([
    "--peer-node=a",
    "--peer-with=b, c",
    "--agent-repl-port=3990",
  ]);
  assertEquals(options?.peers, ["b", "c"]);
  assertEquals(options?.replPort, 3990);
});
