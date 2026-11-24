import { parseModuleGraph, ReloadScheduler, watchDirectories } from "./webxrAutoReload.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("the module graph keeps local files and reports every module that fails", () => {
  const graph = parseModuleGraph({
    modules: [
      { specifier: "file:///repo/petplay/webxr.ts" },
      { specifier: "file:///repo/classes/scene.tsx", error: "SyntaxError: Expected ','" },
      { specifier: "react" },
      { specifier: "https://example.test/mod.ts", error: "Module not found" },
    ],
  });
  assert(graph.files.size === 2, "only file:// modules are watched");
  assert(graph.files.has("/repo/classes/scene.tsx"), "a file with an error is still watched");
  assert(graph.errors.length === 2, "every failing module is reported");
  assert(
    graph.errors[0] === "/repo/classes/scene.tsx: SyntaxError: Expected ','",
    "local errors name the path",
  );
});

Deno.test("directories are watched once each", () => {
  const directories = watchDirectories(["/a/x.ts", "/a/y.ts", "/b/z.ts"]);
  assert(directories.join(",") === "/a,/b", `got ${directories.join(",")}`);
});

Deno.test("a burst of saves becomes one reload with every changed file", async () => {
  const runs: string[][] = [];
  const scheduler = new ReloadScheduler(async (changed) => {
    runs.push(changed);
  }, 20);
  scheduler.notify("/a.ts");
  scheduler.notify("/b.ts");
  scheduler.notify("/a.ts");
  await wait(60);
  assert(runs.length === 1, `expected one run, got ${runs.length}`);
  assert(runs[0]!.join(",") === "/a.ts,/b.ts", `got ${runs[0]!.join(",")}`);
});

Deno.test("a save during a reload queues exactly one more, never a concurrent one", async () => {
  let active = 0;
  let maxActive = 0;
  const runs: string[][] = [];
  const scheduler = new ReloadScheduler(async (changed) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    runs.push(changed);
    await wait(40);
    active -= 1;
  }, 10);
  scheduler.notify("/a.ts");
  await wait(25);
  scheduler.notify("/b.ts");
  scheduler.notify("/c.ts");
  await wait(150);
  assert(maxActive === 1, "reloads must not overlap");
  assert(runs.length === 2, `expected two runs, got ${runs.length}`);
  assert(runs[1]!.join(",") === "/b.ts,/c.ts", `got ${runs[1]!.join(",")}`);
});
