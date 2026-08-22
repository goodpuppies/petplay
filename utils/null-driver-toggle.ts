#!/usr/bin/env -S deno run -A

type JsonObject = Record<string, unknown>;

interface SteamVrPaths {
  nullDriverSettings: string;
  nullDriverManifest: string;
  steamVrSettings: string;
  bigscreenDriverManifests: string[];
}

const valueArg = Deno.args[0];

if (valueArg !== "true" && valueArg !== "false") {
  console.error("Usage: deno run -A utils/null-driver-toggle.ts <true|false>");
  Deno.exit(1);
}

const enabled = valueArg === "true";
const paths = getSteamVrPaths();

await updateJsonFile(paths.nullDriverSettings, (json) => {
  const driverNull = expectObject(
    json.driver_null,
    "driver_null",
    paths.nullDriverSettings,
  );
  driverNull.enable = enabled;
});

await updateJsonFile(paths.nullDriverManifest, (json) => {
  setAlwaysActive(json, enabled);
});

await updateJsonFile(paths.steamVrSettings, (json) => {
  const steamvr = ensureObject(json, "steamvr");

  if (Deno.build.os === "windows") {
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
      const lighthouse = expectObject(
        json.driver_lighthouse,
        "driver_lighthouse",
        paths.steamVrSettings,
      );
      delete lighthouse.enable;
    }
  } else if (enabled) {
    steamvr.forcedDriver = "null";
    steamvr.displayDebug = true;
    steamvr.directMode = false;
  } else {
    delete steamvr.forcedDriver;
    delete steamvr.displayDebug;
    delete steamvr.directMode;
  }
});

for (const manifest of paths.bigscreenDriverManifests) {
  await updateJsonFile(manifest, (json) => {
    setAlwaysActive(json, !enabled);
  });
}

const platformDetail = Deno.build.os === "windows"
  ? `; Bigscreen/lighthouse ${enabled ? "disabled" : "restored"}`
  : "";
console.log(`SteamVR null driver ${enabled ? "enabled" : "disabled"}${platformDetail}.`);

function getSteamVrPaths(): SteamVrPaths {
  if (Deno.build.os === "windows") {
    const steamRoot = Deno.env.get("PETPLAY_STEAM_ROOT") ??
      "C:\\Program Files (x86)\\Steam";
    const steamVrRoot = Deno.env.get("PETPLAY_STEAMVR_ROOT") ??
      `${steamRoot}\\steamapps\\common\\SteamVR`;

    return {
      nullDriverSettings: `${steamVrRoot}\\drivers\\null\\resources\\settings\\default.vrsettings`,
      nullDriverManifest: `${steamVrRoot}\\drivers\\null\\driver.vrdrivermanifest`,
      steamVrSettings: `${steamRoot}\\config\\steamvr.vrsettings`,
      bigscreenDriverManifests: [
        `${steamRoot}\\steamapps\\common\\Bigscreen Beyond Driver\\bin\\steamvr\\BeyondSteamVR\\driver.vrdrivermanifest`,
        `${steamRoot}\\steamapps\\common\\Bigscreen Beyond Driver\\bin\\eyetracking\\ETDriver\\driver.vrdrivermanifest`,
      ],
    };
  }

  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is required to locate SteamVR on Linux");

  const steamRoot = Deno.env.get("PETPLAY_STEAM_ROOT") ??
    `${home}/.local/share/Steam`;
  const steamVrRoot = Deno.env.get("PETPLAY_STEAMVR_ROOT") ??
    `${steamRoot}/steamapps/common/SteamVR`;

  return {
    nullDriverSettings: `${steamVrRoot}/drivers/null/resources/settings/default.vrsettings`,
    nullDriverManifest: `${steamVrRoot}/drivers/null/driver.vrdrivermanifest`,
    steamVrSettings: `${steamRoot}/config/steamvr.vrsettings`,
    bigscreenDriverManifests: [],
  };
}

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
