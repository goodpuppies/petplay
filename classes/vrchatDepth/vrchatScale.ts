/**
 * VRChat's playspace scale, for the depth block's world → tracking fit
 * (`markdown/vrchat-depth/README.md`).
 *
 * VRChat scales the playspace so the wearer's real eye height becomes the avatar's eye height:
 * world metres per real metre = `/avatar/eyeheight` ÷ real eye height. Measured in the lab
 * (2026-11-07) from VRChat's world IPD against OpenVR's: eye height 1.274 m gave 0.7854, 1.6 m gave
 * 0.9864, both a real eye height of 1.6220 m. VRChat's `PlayerHeight` setting was 1.7272 m, so the
 * real eye height is taken as 0.9391 × `PlayerHeight` (one setting measured: the ratio could also be
 * a fixed offset of 10.5 cm; recheck at another height).
 *
 * The avatar eye height comes from VRChat's OSCQuery service, whose port VRChat writes to its log
 * at each launch.
 */

const VRCHAT_APP_ID = 438100;
/** Real eye height ÷ VRChat's `PlayerHeight`, measured once (see above). */
export const EYE_HEIGHT_PER_PLAYER_HEIGHT = 1.622 / 1.7272;
const PLAYER_HEIGHT_KEY = "PlayerHeight_h2758831273";

export function vrchatDataDir(): string | null {
  if (Deno.build.os === "windows") {
    const local = Deno.env.get("LOCALAPPDATA");
    return local ? `${local}\\..\\LocalLow\\VRChat\\VRChat` : null;
  }
  const home = Deno.env.get("HOME");
  return home
    ? `${home}/.local/share/Steam/steamapps/compatdata/${VRCHAT_APP_ID}` +
      "/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat"
    : null;
}

/** VRChat's OSCQuery HTTP port from its newest log, or null. */
export function vrchatOscQueryPort(): number | null {
  const dir = vrchatDataDir();
  if (!dir) return null;
  try {
    const newest = [...Deno.readDirSync(dir)]
      .filter((entry) => entry.name.startsWith("output_log_"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    if (!newest) return null;
    const text = Deno.readTextFileSync(`${dir}/${newest}`);
    const match = [...text.matchAll(/Advertising Service \S+ of type OSCQuery on (\d+)/g)].at(-1);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** `/avatar/eyeheight` (metres) from VRChat's OSCQuery service on `port`. */
export async function readAvatarEyeHeight(port: number): Promise<number | null> {
  const response = await fetch(`http://127.0.0.1:${port}/avatar/eyeheight`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) return null;
  const value = (await response.json()).VALUE?.[0];
  return typeof value === "number" && value > 0 ? value : null;
}

function doubleFromHexBytes(bytes: number[]): number | null {
  if (bytes.length < 8) return null;
  return new DataView(new Uint8Array(bytes.slice(0, 8)).buffer).getFloat64(0, true);
}

/** VRChat's `PlayerHeight` setting (metres), from its PlayerPrefs, or null. */
export async function readVrchatPlayerHeight(): Promise<number | null> {
  try {
    if (Deno.build.os === "windows") {
      const out = await new Deno.Command("reg", {
        args: ["query", "HKCU\\Software\\VRChat\\VRChat", "/v", PLAYER_HEIGHT_KEY],
        stdout: "piped",
        stderr: "null",
      }).output();
      const hex = new TextDecoder().decode(out.stdout).match(/REG_BINARY\s+([0-9A-Fa-f]+)/)?.[1];
      if (!hex) return null;
      return doubleFromHexBytes(hex.match(/../g)!.map((b) => parseInt(b, 16)));
    }
    const home = Deno.env.get("HOME");
    const reg = Deno.readTextFileSync(
      `${home}/.local/share/Steam/steamapps/compatdata/${VRCHAT_APP_ID}/pfx/user.reg`,
    );
    const hex = reg.match(new RegExp(`"${PLAYER_HEIGHT_KEY}"=hex\\(4\\):([0-9a-f,]+)`))?.[1];
    if (!hex) return null;
    return doubleFromHexBytes(hex.split(",").map((b) => parseInt(b, 16)));
  } catch {
    return null;
  }
}

/**
 * Polls VRChat's avatar eye height and works out the playspace scale. `scale()` is VRChat world
 * metres per real metre, or null until both heights are known.
 */
export class VrchatScaleTracker {
  private port: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  avatarEyeHeight: number | null = null;
  realEyeHeight: number | null = null;
  /** Set by the user; replaces the PlayerHeight estimate. */
  realEyeHeightOverride: number | null = null;
  lastError: string | null = null;

  start(intervalMs = 1000): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
    void readVrchatPlayerHeight().then((height) => {
      if (height != null) this.realEyeHeight = height * EYE_HEIGHT_PER_PLAYER_HEIGHT;
    });
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  scale(): number | null {
    const real = this.realEyeHeightOverride ?? this.realEyeHeight;
    return this.avatarEyeHeight != null && real != null ? this.avatarEyeHeight / real : null;
  }

  private async poll(): Promise<void> {
    try {
      this.port ??= vrchatOscQueryPort();
      if (this.port == null) {
        this.lastError = "VRChat's OSCQuery port is not in its log";
        return;
      }
      const height = await readAvatarEyeHeight(this.port);
      if (height != null) this.avatarEyeHeight = height;
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error);
      this.port = null; // VRChat restarted: look the port up again
    }
  }
}
