/**
 * What PetPlay has learned about each VRChat world's locomotion (jump, later walking), so a
 * world it has seen before is predicted well from the first jump. Kept in PetPlay's state
 * directory, keyed by world id (`wrld_…`).
 */
import { join } from "@std/path";
import { stateDir } from "./appPaths.ts";
import type { VrcJumpParams } from "./vrcJumpModel.ts";

export interface VrcWorldLocomotion {
  jump?: VrcJumpParams;
  /** ISO time of the last change. */
  updatedAt?: string;
}

const SAVE_DELAY_MS = 2000;

export class VrcWorldLocomotionStore {
  private data: Record<string, VrcWorldLocomotion> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly path = join(stateDir(), "vrc-world-locomotion.json")) {
    try {
      const parsed = JSON.parse(Deno.readTextFileSync(path));
      if (parsed && typeof parsed === "object") this.data = parsed;
    } catch {
      // First run, or unreadable: start empty.
    }
  }

  get(worldId: string): VrcWorldLocomotion | undefined {
    return this.data[worldId];
  }

  setJump(worldId: string, jump: VrcJumpParams): void {
    this.data[worldId] = {
      ...this.data[worldId],
      jump: { ...jump },
      updatedAt: new Date().toISOString(),
    };
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save(): void {
    try {
      Deno.mkdirSync(join(this.path, ".."), { recursive: true });
      const tmp = `${this.path}.tmp`;
      Deno.writeTextFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
      Deno.renameSync(tmp, this.path);
    } catch {
      // Losing a learned value is harmless: it is learned again.
    }
  }
}
