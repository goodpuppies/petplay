import { PostMan } from "../submodules/stageforge/mod.ts";


const state = {

};

new PostMan(state, {
  CUSTOMINIT: (_payload) => { main() },
} as const);

async function main() {
  const command = new Deno.Command("deno", {
    args: ["task", "dev"],
    cwd: "./submodules/frontend", // or the absolute path if needed
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const process = command.spawn();
  await process.status;
}


