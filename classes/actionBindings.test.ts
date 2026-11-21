import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "@std/path";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(Deno.readTextFileSync(new URL("resources/actions.json", root)));

Deno.test("native Frame bindings use Valve's handed OpenVR input paths", () => {
  const entry = manifest.default_bindings.find((binding: { controller_type: string }) =>
    binding.controller_type === "frame_controller"
  );
  assert(entry);
  const binding = JSON.parse(
    Deno.readTextFileSync(new URL(`resources/${entry.binding_url}`, root)),
  );
  assertEquals(binding.controller_type, "frame_controller");
  const main = binding.bindings["/actions/main"];
  const actions = new Set(manifest.actions.map((action: { name: string }) => action.name));
  const shared = ["trigger", "grip", "thumbstick", "bumper", "system"];
  const allowed = {
    left: new Set([...shared, "dpad_up", "dpad_down", "dpad_left", "dpad_right", "view"]),
    right: new Set([...shared, "a", "b", "x", "y", "menu"]),
  };
  for (const source of main.sources) {
    const match = /^\/user\/hand\/(left|right)\/input\/([^/]+)$/.exec(source.path);
    assert(match, source.path);
    assert(allowed[match[1] as "left" | "right"].has(match[2]!), source.path);
    for (const input of Object.values(source.inputs) as { output: string }[]) {
      assert(actions.has(input.output), input.output);
    }
  }
  for (const hand of ["left", "right"]) {
    const side = hand === "left" ? "Left" : "Right";
    for (
      const [component, action, input] of [
        ["trigger", "Trigger", "click"],
        ["grip", "Grab", "click"],
        ["thumbstick", "Joystick", "position"],
      ]
    ) {
      const source = main.sources.find((s: { path: string }) =>
        s.path === `/user/hand/${hand}/input/${component}`
      );
      assert(source);
      assertEquals(source.inputs[input!].output, `/actions/main/in/${action}${side}`);
    }
    assert(
      main.poses.some((p: { path: string; output: string }) =>
        p.path === `/user/hand/${hand}/pose/raw` && p.output === `/actions/main/in/HandPose${side}`
      ),
    );
    assert(
      main.haptics.some((h: { path: string }) => h.path === `/user/hand/${hand}/output/haptic`),
    );
  }
});

Deno.test("DroidFrame defaults bind analog trigger and squeeze to PetPlay click/grab", () => {
  const entry = manifest.default_bindings.find((binding: { controller_type: string }) =>
    binding.controller_type === "droidframe_quest"
  );
  assert(entry, "engineering controllers need their own default binding");
  const binding = JSON.parse(
    Deno.readTextFileSync(new URL(`resources/${entry.binding_url}`, root)),
  );
  assertEquals(binding.controller_type, entry.controller_type);
  const actions = new Set(manifest.actions.map((action: { name: string }) => action.name));
  const sources = binding.bindings["/actions/main"].sources;
  for (const hand of ["left", "right"]) {
    for (const [component, action] of [["trigger", "Trigger"], ["squeeze", "Grab"]]) {
      const source = sources.find((s: { path: string }) =>
        s.path === `/user/hand/${hand}/input/${component}`
      );
      assert(source);
      assertEquals(source.mode, "trigger");
      assertEquals(
        source.inputs.click.output,
        `/actions/main/in/${action}${hand === "left" ? "Left" : "Right"}`,
      );
      assert(
        Number(source.parameters.click_activate_threshold) >
          Number(source.parameters.click_deactivate_threshold),
      );
      assert(actions.has(source.inputs.click.output));
    }
    assert(sources.some((s: { path: string }) => s.path === `/user/hand/${hand}/input/thumbstick`));
  }
});

Deno.test("runtime staging repairs missing bindings beside an existing binding", async () => {
  const directory = await Deno.makeTempDir({ prefix: "petplay-bindings-" });
  try {
    const code = `
      import { createTemp, destroyTemp } from ${JSON.stringify(new URL("classes/utils.ts", root).href)};
      import { tempDir } from ${JSON.stringify(new URL("classes/appPaths.ts", root).href)};
      const directory = tempDir() + "/run-" + Deno.pid;
      try {
        Deno.mkdirSync(directory, { recursive: true });
        Deno.copyFileSync(${
      JSON.stringify(fromFileUrl(new URL("resources/bindings_oculus_touch.json", root)))
    }, directory + "/bindings_oculus_touch.json");
        createTemp();
        const manifest = ${JSON.stringify(manifest)};
        for (const binding of manifest.default_bindings) {
          const file = JSON.parse(Deno.readTextFileSync(directory + "/" + binding.binding_url));
          if (file.controller_type !== binding.controller_type) throw new Error(binding.binding_url);
        }
      } finally {
        destroyTemp();
      }
    `;
    const result = await new Deno.Command(Deno.execPath(), {
      cwd: directory,
      args: ["eval", "--config", fromFileUrl(new URL("deno.json", root)), code],
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("every default binding drags the playspace from the left hand", () => {
  assert(
    manifest.actions.some((action: { name: string; type: string }) =>
      action.name === "/actions/main/in/SpaceDrag" && action.type === "boolean"
    ),
  );
  for (const { binding_url } of manifest.default_bindings) {
    const binding = JSON.parse(Deno.readTextFileSync(new URL(`resources/${binding_url}`, root)));
    const main = binding.bindings["/actions/main"];
    const sources = main.sources as {
      path: string;
      inputs: Record<string, { output: string }>;
    }[];
    const clicks = sources.filter((s) => s.inputs.click?.output === "/actions/main/in/SpaceDrag");
    const chords = ((main.chords ?? []) as { output: string; inputs: string[][] }[])
      .filter((c) => c.output === "/actions/main/in/SpaceDrag");
    if (binding.controller_type === "knuckles") {
      // Index: left grip + left trackpad touch; the stick click stays free.
      assertEquals(clicks.length, 0, binding_url);
      assertEquals(chords.length, 1, binding_url);
      assertEquals(chords[0].inputs, [
        ["/user/hand/left/input/grip", "click"],
        ["/user/hand/left/input/trackpad", "touch"],
      ]);
      for (const [path] of chords[0].inputs) {
        assert(sources.some((s) => s.path === path), `${binding_url}: chord needs ${path}`);
      }
      continue;
    }
    assertEquals(clicks.length, 1, binding_url);
    assertEquals(chords.length, 0, binding_url);
    assert(/^\/user\/hand\/left\/input\/(joystick|thumbstick)$/.test(clicks[0].path), binding_url);
  }
});
