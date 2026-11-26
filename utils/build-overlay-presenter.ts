import { fromFileUrl } from "@std/path";
const root = new URL("../", import.meta.url);
const projectDir = fromFileUrl(new URL("native/overlayPresenter", root));
const targetArg = Deno.args.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const isWindows = targetArg ? targetArg.includes("windows") : Deno.build.os === "windows";
const builtName = isWindows
  ? "petplay_overlay_presenter.dll"
  : "libpetplay_overlay_presenter.so";
const builtPath = fromFileUrl(
  new URL(
    `native/overlayPresenter/zig-out/${isWindows ? "bin" : "lib"}/${builtName}`,
    root,
  ),
);
const output = fromFileUrl(new URL(`resources/${builtName}`, root));

const result = await new Deno.Command(Deno.env.get("ZIG") ?? "zig", {
  cwd: projectDir,
  args: [
    "build",
    "-Doptimize=ReleaseFast",
    "-Dcpu=baseline",
    ...(targetArg ? [`-Dtarget=${targetArg}`] : []),
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!result.success) Deno.exit(result.code);

// Copy beside the library and rename over it: a running renderer keeps its mapped copy.
const temporary = `${output}.${Deno.pid}.tmp`;
Deno.copyFileSync(builtPath, temporary);
Deno.renameSync(temporary, output);
console.log(`Built ${output} (pure Zig${targetArg ? `, target=${targetArg}` : ""})`);
