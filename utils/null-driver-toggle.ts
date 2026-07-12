#!/usr/bin/env -S deno run -A

const NULL_DRIVER_SETTINGS =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\SteamVR\\drivers\\null\\resources\\settings\\default.vrsettings";
const NULL_DRIVER_MANIFEST =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\SteamVR\\drivers\\null\\driver.vrdrivermanifest";
const STEAMVR_SETTINGS = "C:\\Program Files (x86)\\Steam\\config\\steamvr.vrsettings";
const BIGSCREEN_DRIVER_MANIFESTS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Bigscreen Beyond Driver\\bin\\steamvr\\BeyondSteamVR\\driver.vrdrivermanifest",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Bigscreen Beyond Driver\\bin\\eyetracking\\ETDriver\\driver.vrdrivermanifest",
];

type JsonObject = Record<string, unknown>;

const valueArg = Deno.args[0];

if (valueArg !== "true" && valueArg !== "false") {
  console.error("Usage: deno run -A utils/null-driver-toggle.ts <true|false>");
  Deno.exit(1);
}

const enabled = valueArg === "true";

await updateJsonFile(NULL_DRIVER_SETTINGS, (json) => {
  const driverNull = expectObject(json.driver_null, "driver_null", NULL_DRIVER_SETTINGS);
  driverNull.enable = enabled;
});

await updateJsonFile(NULL_DRIVER_MANIFEST, (json) => {
  setAlwaysActive(json, enabled);
});

await updateJsonFile(STEAMVR_SETTINGS, (json) => {
  const steamvr = ensureObject(json, "steamvr");
  steamvr.forcedDriver = enabled ? "null" : "";
  steamvr.activateMultipleDrivers = !enabled;

  const beyondSteamVr = ensureObject(json, "driver_BeyondSteamVR");
  beyondSteamVr.enable = !enabled;

  const beyondEyetracking = ensureObject(json, "driver_BeyondEyetracking");
  beyondEyetracking.enable = !enabled;

  if (enabled) {
    const lighthouse = ensureObject(json, "driver_lighthouse");
    lighthouse.enable = false;
  } else {
    const lighthouse = expectObject(json.driver_lighthouse, "driver_lighthouse", STEAMVR_SETTINGS);
    delete lighthouse.enable;
  }
});

for (const manifest of BIGSCREEN_DRIVER_MANIFESTS) {
  await updateJsonFile(manifest, (json) => {
    setAlwaysActive(json, !enabled);
  });
}

console.log(
  `SteamVR null driver ${enabled ? "enabled" : "disabled"}; Bigscreen/lighthouse ${
    enabled ? "disabled" : "restored"
  }.`,
);

async function updateJsonFile(
  path: string,
  update: (json: JsonObject) => void,
): Promise<void> {
  const source = await Deno.readTextFile(path);
  const json = JSON.parse(source) as JsonObject;

  update(json);

  await Deno.writeTextFile(path, `${JSON.stringify(json, null, 4)}\n`);
}

function expectObject(value: unknown, key: string, path: string): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error(`${path} is missing object key "${key}"`);
}

function ensureObject(json: JsonObject, key: string): JsonObject {
  const value = json[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  const object: JsonObject = {};
  json[key] = object;
  return object;
}

function setAlwaysActive(json: JsonObject, value: boolean): void {
  if ("alwaysActivate" in json) {
    json.alwaysActivate = value;
    return;
  }

  if ("alwaysActive" in json) {
    json.alwaysActive = value;
    return;
  }

  json.alwaysActivate = value;
}
