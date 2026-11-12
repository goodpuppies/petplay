import { fromFileUrl } from "@std/path";

if (Deno.build.os !== "linux") {
  throw new Error("The experimental Pathfinder text build currently supports Linux only");
}
const root = new URL("../", import.meta.url);
const scratch = fromFileUrl(new URL("_scratch/", root));
const target = `${scratch}pathfinder-native-target`;
const output = fromFileUrl(new URL("resources/libpetplay_pathfinder_text.so", root));
const result = await new Deno.Command("cargo", {
  args: [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    fromFileUrl(new URL("native/pathfinderText/Cargo.toml", root)),
  ],
  env: { CARGO_HOME: `${scratch}pathfinder-cargo`, CARGO_TARGET_DIR: target },
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!result.success) Deno.exit(result.code);
const temporary = `${output}.${Deno.pid}.tmp`;
await Deno.copyFile(`${target}/release/libpetplay_pathfinder_text.so`, temporary);
await Deno.rename(temporary, output);
console.log(`Built ${output}`);
