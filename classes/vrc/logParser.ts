/**
 * Parses VRChat's `output_log_*.txt` to track the local user, current world/instance, and
 * players currently in the instance — with zero VRChat API credentials.
 *
 * Line shapes observed in VRChat logs:
 *   - Local user:
 *       `[Authentication - ...] Preforming post login checks for <name> (<usr_...>)`
 *       `User Authenticated: <name> (<usr_...>)`
 *   - Room / instance:
 *       `[Behaviour] Entering Room: <worldName>`
 *       `[Behaviour] Joining wrld_<uuid>:<instanceTags>`
 *       `[Behaviour] OnLeftRoom`
 *   - Players:
 *       `[Behaviour] OnPlayerJoined <name> (<usr_...>)`
 *       `[Behaviour] OnPlayerLeft <name> (<usr_...>)`
 */
import { join } from "@std/path";
import { vrchatDataDir } from "../vrchatDepth/vrchatScale.ts";

export type VrcPlayer = {
  userId: string;
  displayName: string;
};

export type VrcLogState = {
  logFile: string | null;
  self: VrcPlayer | null;
  worldName: string | null;
  instanceId: string | null;
  players: VrcPlayer[];
};

const RE_POST_LOGIN = /Pr(?:eform|erform)ing post login checks for (.+?) \((usr_[a-f0-9-]+)\)/i;
const RE_USER_AUTH = /User Authenticated:\s*(.+?)\s*\((usr_[a-f0-9-]+)\)/;
const RE_ENTERING_ROOM = /\[Behaviour\]\s+Entering Room:\s*(.+)$/;
const RE_JOINING_INSTANCE = /\[Behaviour\]\s+Joining (wrld_\S+)/;
const RE_ON_LEFT_ROOM = /\[Behaviour\]\s+OnLeftRoom\b/;
const RE_PLAYER_JOINED = /\[Behaviour\]\s+OnPlayerJoined (.+?) \((usr_[a-f0-9-]+)\)/;
const RE_PLAYER_LEFT = /\[Behaviour\]\s+OnPlayerLeft (.+?) \((usr_[a-f0-9-]+)\)/;

/** Stateful line-by-line parser for a single VRChat `output_log_*.txt` session. */
export class VrcLogParser {
  self: VrcPlayer | null = null;
  worldName: string | null = null;
  instanceId: string | null = null;
  #players = new Map<string, VrcPlayer>();

  reset(): void {
    this.self = null;
    this.worldName = null;
    this.instanceId = null;
    this.#players.clear();
  }

  /** Feeds one log line. Returns true if any tracked state changed. */
  feedLine(rawLine: string): boolean {
    const line = rawLine.trim();
    if (!line) return false;

    const authMatch = RE_POST_LOGIN.exec(line) ?? RE_USER_AUTH.exec(line);
    if (authMatch) {
      const displayName = authMatch[1].trim();
      const userId = authMatch[2];
      const changed = this.self?.userId !== userId || this.self?.displayName !== displayName;
      this.self = { userId, displayName };
      return changed;
    }

    if (RE_ON_LEFT_ROOM.test(line)) {
      const changed = this.instanceId !== null || this.worldName !== null || this.#players.size > 0;
      this.instanceId = null;
      this.worldName = null;
      this.#players.clear();
      return changed;
    }

    const enterMatch = RE_ENTERING_ROOM.exec(line);
    if (enterMatch) {
      const worldName = enterMatch[1].trim();
      const changed = this.worldName !== worldName;
      this.worldName = worldName;
      return changed;
    }

    const joinMatch = RE_JOINING_INSTANCE.exec(line);
    if (joinMatch) {
      const instanceId = joinMatch[1].trim();
      const changed = this.instanceId !== instanceId || this.#players.size > 0;
      if (this.instanceId !== instanceId) {
        this.#players.clear();
      }
      this.instanceId = instanceId;
      return changed;
    }

    const joinedMatch = RE_PLAYER_JOINED.exec(line);
    if (joinedMatch) {
      const displayName = joinedMatch[1].trim();
      const userId = joinedMatch[2];
      const prev = this.#players.get(userId);
      const changed = !prev || prev.displayName !== displayName;
      this.#players.set(userId, { userId, displayName });
      return changed;
    }

    const leftMatch = RE_PLAYER_LEFT.exec(line);
    if (leftMatch) {
      const userId = leftMatch[2];
      return this.#players.delete(userId);
    }

    return false;
  }

  /** Feeds a multi-line chunk (splits on `\n`). Returns true if any state changed. */
  feedText(text: string): boolean {
    let changed = false;
    for (const line of text.split(/\r?\n/)) {
      if (this.feedLine(line)) changed = true;
    }
    return changed;
  }

  players(): VrcPlayer[] {
    return [...this.#players.values()];
  }

  hasPlayer(userId: string): boolean {
    return this.#players.has(userId);
  }

  snapshot(logFile: string | null = null): VrcLogState {
    return {
      logFile,
      self: this.self ? { ...this.self } : null,
      worldName: this.worldName,
      instanceId: this.instanceId,
      players: this.players(),
    };
  }
}

/**
 * Follows VRChat's newest `output_log_*.txt`.
 *
 * Unlike `WorldWatcher`, this reads from byte 0 when first attaching to a log so PetPlay
 * recovers the local user, current instance, and players even when started after VRChat.
 */
export class VrcLogWatcher {
  #logDirOverride: string | null;
  #file: string | null = null;
  #offset = 0;
  #remainder = "";
  #parser = new VrcLogParser();
  #decoder = new TextDecoder();

  constructor(options?: { logDir?: string | null }) {
    this.#logDirOverride = options?.logDir ?? null;
  }

  setLogDir(logDir: string | null): void {
    if (this.#logDirOverride === logDir) return;
    this.#logDirOverride = logDir;
    this.#file = null;
    this.#offset = 0;
    this.#remainder = "";
    this.#parser.reset();
  }

  get state(): VrcLogState {
    return this.#parser.snapshot(this.#file);
  }

  hasPlayer(userId: string): boolean {
    return this.#parser.hasPlayer(userId);
  }

  /** Reads any newly written log bytes. Returns true if tracked state changed. */
  poll(): boolean {
    const dir = this.#logDirOverride ?? vrchatDataDir();
    if (!dir) return false;

    let newest: string | undefined;
    try {
      newest = [...Deno.readDirSync(dir)]
        .filter((entry) => entry.isFile && entry.name.startsWith("output_log_"))
        .map((entry) => entry.name)
        .sort()
        .at(-1);
    } catch {
      return false;
    }
    if (!newest) return false;

    const path = join(dir, newest);
    let changed = false;

    if (path !== this.#file) {
      this.#file = path;
      this.#offset = 0;
      this.#remainder = "";
      this.#parser.reset();
      changed = true;
    }

    let size: number;
    try {
      size = Deno.statSync(path).size;
    } catch {
      return changed;
    }

    // Handle log truncation (e.g. file replaced in-place during tests).
    if (size < this.#offset) {
      this.#offset = 0;
      this.#remainder = "";
      this.#parser.reset();
      changed = true;
    }

    if (size === this.#offset) return changed;

    const file = Deno.openSync(path, { read: true });
    try {
      file.seekSync(this.#offset, Deno.SeekMode.Start);
      let remaining = size - this.#offset;
      const chunkBuf = new Uint8Array(Math.min(remaining, 256 * 1024));
      while (remaining > 0) {
        const toRead = Math.min(remaining, chunkBuf.length);
        const view = toRead === chunkBuf.length ? chunkBuf : chunkBuf.subarray(0, toRead);
        const read = file.readSync(view);
        if (read === null || read === 0) break;
        this.#offset += read;
        remaining -= read;
        const text = this.#remainder + this.#decoder.decode(view.subarray(0, read), { stream: true });
        const lines = text.split(/\r?\n/);
        this.#remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (this.#parser.feedLine(line)) changed = true;
        }
      }
    } finally {
      file.close();
    }

    return changed;
  }
}
