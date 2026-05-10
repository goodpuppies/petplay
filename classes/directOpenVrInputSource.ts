/**
 * Single source of truth for app-wide OpenVR input (HMD, controller poses, and
 * eventually button / analog state). Populated from the same
 * `OpenVrOverlayFramePacer` cycle that drives the smooth Raylib debug-cube
 * rendering path, so consumers can share that prediction horizon instead of
 * each computing their own (which is the current source of jitter in the
 * IVRInput / iwer → r3f path).
 *
 * Design notes:
 * - All per-frame updates are **allocation-free**. Pose components are copied
 *   into preallocated `Float32Array` buffers; the snapshot object itself is
 *   stable (same object identity across frames) and its inner hand/hmd objects
 *   are either stable or `null`.
 * - `Float32Array` fields on the returned snapshot are **shared mutating
 *   buffers**. Consumers that need stable copies must `slice()` themselves.
 * - Buttons/analog state are intentionally omitted for now; they'll be added
 *   here once we fold the existing IVRInput digital reads into this source.
 */

import type { OpenVrHmdEmulationPose } from "./openVrOverlayFramePacing.ts";

export type DirectOpenVrHmdPose = {
  /** Column-major 4x4 world-from-HMD matrix. */
  matrix: Float32Array;
  /** XYZ world position. */
  position: Float32Array;
  /** XYZW world-orientation quaternion. */
  quaternion: Float32Array;
};

export type DirectOpenVrControllerPose = {
  /** XYZ world position. */
  position: Float32Array;
  /** XYZW world-orientation quaternion. */
  quaternion: Float32Array;
};

export type DirectOpenVrInputSnapshot = {
  hmd: DirectOpenVrHmdPose | null;
  controllers: {
    left: DirectOpenVrControllerPose | null;
    right: DirectOpenVrControllerPose | null;
  };
};

export class DirectOpenVrInputSource {
  private readonly hmdBuffers = {
    matrix: new Float32Array(16),
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
  };
  private readonly leftBuffers = {
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
  };
  private readonly rightBuffers = {
    position: new Float32Array(3),
    quaternion: new Float32Array(4),
  };

  private readonly hmdView: DirectOpenVrHmdPose = {
    matrix: this.hmdBuffers.matrix,
    position: this.hmdBuffers.position,
    quaternion: this.hmdBuffers.quaternion,
  };
  private readonly leftView: DirectOpenVrControllerPose = {
    position: this.leftBuffers.position,
    quaternion: this.leftBuffers.quaternion,
  };
  private readonly rightView: DirectOpenVrControllerPose = {
    position: this.rightBuffers.position,
    quaternion: this.rightBuffers.quaternion,
  };

  private hmdValid = false;
  private leftValid = false;
  private rightValid = false;

  /** Stable snapshot object. Inner `hmd` / `controllers.left|right` are toggled between the stable view and `null`. */
  private readonly snapshot: DirectOpenVrInputSnapshot = {
    hmd: null,
    controllers: { left: null, right: null },
  };

  /**
   * Update the snapshot from freshly-read pacer poses. Pass `null` for any
   * role that is unavailable / invalid this frame. Does not allocate.
   */
  update(
    hmd: OpenVrHmdEmulationPose | null,
    left: OpenVrHmdEmulationPose | null,
    right: OpenVrHmdEmulationPose | null,
  ): void {
    if (hmd) {
      this.hmdBuffers.matrix.set(hmd.matrix);
      this.hmdBuffers.position[0] = hmd.position[0];
      this.hmdBuffers.position[1] = hmd.position[1];
      this.hmdBuffers.position[2] = hmd.position[2];
      this.hmdBuffers.quaternion[0] = hmd.quaternion[0];
      this.hmdBuffers.quaternion[1] = hmd.quaternion[1];
      this.hmdBuffers.quaternion[2] = hmd.quaternion[2];
      this.hmdBuffers.quaternion[3] = hmd.quaternion[3];
      this.hmdValid = true;
    } else {
      this.hmdValid = false;
    }

    if (left) {
      this.leftBuffers.position[0] = left.position[0];
      this.leftBuffers.position[1] = left.position[1];
      this.leftBuffers.position[2] = left.position[2];
      this.leftBuffers.quaternion[0] = left.quaternion[0];
      this.leftBuffers.quaternion[1] = left.quaternion[1];
      this.leftBuffers.quaternion[2] = left.quaternion[2];
      this.leftBuffers.quaternion[3] = left.quaternion[3];
      this.leftValid = true;
    } else {
      this.leftValid = false;
    }

    if (right) {
      this.rightBuffers.position[0] = right.position[0];
      this.rightBuffers.position[1] = right.position[1];
      this.rightBuffers.position[2] = right.position[2];
      this.rightBuffers.quaternion[0] = right.quaternion[0];
      this.rightBuffers.quaternion[1] = right.quaternion[1];
      this.rightBuffers.quaternion[2] = right.quaternion[2];
      this.rightBuffers.quaternion[3] = right.quaternion[3];
      this.rightValid = true;
    } else {
      this.rightValid = false;
    }

    this.snapshot.hmd = this.hmdValid ? this.hmdView : null;
    this.snapshot.controllers.left = this.leftValid ? this.leftView : null;
    this.snapshot.controllers.right = this.rightValid ? this.rightView : null;
  }

  /** Clear all validity flags without zeroing buffers. */
  clear(): void {
    this.hmdValid = false;
    this.leftValid = false;
    this.rightValid = false;
    this.snapshot.hmd = null;
    this.snapshot.controllers.left = null;
    this.snapshot.controllers.right = null;
  }

  /**
   * Read-only snapshot accessor. The returned object identity is stable across
   * frames and its inner `Float32Array` fields are shared mutating buffers.
   */
  getSnapshot(): DirectOpenVrInputSnapshot {
    return this.snapshot;
  }

  hasHmd(): boolean {
    return this.hmdValid;
  }

  hasLeftController(): boolean {
    return this.leftValid;
  }

  hasRightController(): boolean {
    return this.rightValid;
  }
}
