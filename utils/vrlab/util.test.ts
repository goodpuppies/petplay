import { assertEquals } from "jsr:@std/assert";
import { pidsMatching } from "./util.ts";
Deno.test("workload discovery finds the worker but excludes shell command text and its own ancestors", async () => {
  const token = `petplay-discovery-${crypto.randomUUID()}`;
  const worker = new Deno.Command(Deno.execPath(), {
    args: ["eval", "setInterval(() => {}, 1000)", token],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const shell = new Deno.Command("bash", {
    args: ["-c", `sleep 30 # ${token}`],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(pidsMatching(token), [worker.pid]);
    assertEquals(pidsMatching("util.test.ts").includes(Deno.pid), false);
  } finally {
    worker.kill("SIGTERM");
    shell.kill("SIGTERM");
    await Promise.all([worker.status, shell.status]);
  }
});
