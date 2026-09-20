import {
  CHILD_MODULE_FLAG,
  childModuleHref,
  childProcessArgs,
  dispatchChildModule,
} from "./childModule.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertArgs(actual: readonly string[], expected: readonly string[], message: string): void {
  assert(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

Deno.test("a source build runs the child module through the Deno CLI", () => {
  const args = childProcessArgs(new URL("file:///app/child.ts"), ["--title=x"], false);
  assertArgs(
    args.slice(0, 5),
    ["run", "-A", "--unstable-webgpu", "--env-file", "--no-check"],
    "the CLI flags lead",
  );
  assert(args.includes("file:///app/child.ts"), "the module follows the flags");
  assert(
    args.indexOf("file:///app/child.ts") < args.indexOf("--title=x"),
    "the child's own arguments come after the module",
  );
  assert(
    !args.some((arg) => arg.startsWith(CHILD_MODULE_FLAG)),
    "a source build never dispatches",
  );
});

Deno.test("a compiled build dispatches itself, keeping the child's arguments", () => {
  assertArgs(
    childProcessArgs(new URL("file:///snapshot/child.ts"), ["--title=x"], true),
    [`${CHILD_MODULE_FLAG}file:///snapshot/child.ts`, "--title=x"],
    "the module and the child's arguments are the whole argv",
  );
});

Deno.test("only a dispatched invocation carries the module to run", () => {
  assert(childModuleHref(["--novr", "--desktop"]) === null, "a normal start dispatches nothing");
  assert(
    childModuleHref([`${CHILD_MODULE_FLAG}file:///snapshot/child.ts`, "--title=x"]) ===
      "file:///snapshot/child.ts",
    "the flagged invocation names the module",
  );
});

Deno.test("a dispatched module is handed the child's arguments, not the dispatcher's", async () => {
  const href = new URL("./childModule.ts", import.meta.url).href;
  const ran = await dispatchChildModule([
    `${CHILD_MODULE_FLAG}${href}`,
    "--title=child title",
    "--desktop-control-child",
  ]);
  assert(ran === href, "the dispatcher reports the module it ran");
  assertArgs(
    Deno.args,
    ["--title=child title", "--desktop-control-child"],
    "the child reads its own arguments",
  );
});
