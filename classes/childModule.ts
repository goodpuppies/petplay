/**
 * How PetPlay starts another PetPlay process.
 *
 * A source checkout hands the child module to the Deno CLI — `deno run -A … <script> <args>`. A
 * compiled build has nothing to hand it to: `deno compile` embeds `denort`, which ships none of the
 * CLI subcommands, so `run -A <script>` reaches the launcher as ordinary arguments and boots the app
 * a second time. Instead the binary dispatches itself — the parent re-execs the same executable with
 * `--petplay-run-module=<href>`, and the entry consumes that before anything else, importing the
 * module out of its own embedded snapshot.
 *
 * Both forms hand the module the same argv, so a child entry needs no knowledge of which one started
 * it. Source-only launchers (`utils/dev-runner.ts`, `utils/overlay-perf.ts`, `petplay/client.ts`)
 * keep their direct `deno run` calls: they exist only in a checkout, where they already are the
 * launcher.
 */
export const CHILD_MODULE_FLAG = "--petplay-run-module=";

/** `true` inside a `deno compile` output: no Deno CLI, no sibling files, only the snapshot. */
export const IS_STANDALONE_BUILD: boolean = Deno.build.standalone;

/**
 * Arguments for `new Deno.Command(Deno.execPath(), …)` that run `scriptUrl` as a child process.
 *
 * `standalone` is a parameter so both branches stay testable.
 */
export function childProcessArgs(
  scriptUrl: URL,
  args: readonly string[] = [],
  standalone: boolean = IS_STANDALONE_BUILD,
): string[] {
  if (standalone) {
    return [`${CHILD_MODULE_FLAG}${scriptUrl.href}`, ...args];
  }
  const commandArgs = [
    "run",
    "-A",
    "--unstable-webgpu",
    "--env-file",
    "--no-check",
  ];
  // A child whose own directory holds a `deno.json` (stageforge does) would otherwise resolve that
  // one instead of the project the caller is running from.
  const configPath = `${Deno.cwd().replace(/\/$/, "")}/deno.json`;
  try {
    Deno.statSync(configPath);
    commandArgs.push(`--config=${configPath}`);
  } catch {
    // Deno can resolve the child without an explicit project config.
  }
  commandArgs.push(scriptUrl.href, ...args);
  return commandArgs;
}

/** The module this invocation was dispatched to run, or `null` for a normal start. */
export function childModuleHref(args: readonly string[]): string | null {
  return args
    .find((arg) => arg.startsWith(CHILD_MODULE_FLAG))
    ?.slice(CHILD_MODULE_FLAG.length) ?? null;
}

/**
 * Runs the dispatched module if this invocation is one. The child's own arguments replace
 * `Deno.args`, so a child entry reads them exactly as it would when spawned directly.
 *
 * Returns the href that was run, or `null` when this is a normal start and the caller should boot.
 */
export async function dispatchChildModule(
  args: readonly string[],
): Promise<string | null> {
  const href = childModuleHref(args);
  if (href == null) {
    return null;
  }
  // `Deno.args` is a configurable getter, so the child's arguments can be installed over the
  // dispatcher's own before the module reads them.
  Object.defineProperty(Deno, "args", {
    value: args.filter((arg) => !arg.startsWith(CHILD_MODULE_FLAG)),
    configurable: true,
  });
  // Runtime-selected specifier by design: which module to run arrives in argv, so no static import
  // can name it. It resolves inside the snapshot, which is the only place the module exists once the
  // build is compiled.
  await import(href);
  return href;
}
