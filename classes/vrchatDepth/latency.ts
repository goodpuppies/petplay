import type { VrcWorldCameraPose } from "../vrcCameraCalibration.ts";

export type DepthFrameTiming = {
  revision: number;
  pose: VrcWorldCameraPose;
  capturedAt: number;
  sourceCapturedAt?: number;
  decodedAt?: number;
  deliveredAt: number;
  preparedAt: number;
};
type Command = {
  sequence: number;
  pose: VrcWorldCameraPose;
  sentAt: number;
  ackAt?: number;
  frame?: DepthFrameTiming;
};
export type DepthLatencySample = {
  sequence: number;
  commandToCaptureMs: number;
  commandToSourceMs: number | null;
  sourceToArrivalMs: number | null;
  captureToDecodeMs: number | null;
  decodeToDeliveryMs: number | null;
  prepareMs: number;
  prepareToSwapMs: number;
  commandAckMs: number | null;
  totalMs: number;
};

/** Actual captured-pose matches. Endpoint is a software window swap, not photons on screen. */
export class DepthLatencyTracker {
  private commands = new Map<number, Command>();
  private sequence = 0;
  private samples: DepthLatencySample[] = [];
  private expired = 0;
  private lastObservedRevision = -1;

  reset() {
    this.commands.clear();
    this.samples = [];
    this.expired = 0;
    this.lastObservedRevision = -1;
  }

  command(pose: VrcWorldCameraPose, sentAt: number): number {
    for (const [sequence, command] of this.commands) {
      if (sentAt - command.sentAt > 2000 || this.commands.size >= 256) {
        this.commands.delete(sequence);
        this.expired++;
      }
    }
    const sequence = ++this.sequence;
    this.commands.set(sequence, {
      sequence,
      sentAt,
      pose: {
        position: [...pose.position],
        rotationDeg: [...pose.rotationDeg],
      },
    });
    return sequence;
  }

  acknowledge(sequence: number, at: number) {
    const command = this.commands.get(sequence);
    if (command) command.ackAt = at;
  }

  observe(frame: DepthFrameTiming) {
    if (frame.revision === this.lastObservedRevision) return;
    this.lastObservedRevision = frame.revision;
    for (const command of [...this.commands.values()].reverse()) {
      if ((frame.sourceCapturedAt ?? frame.capturedAt) < command.sentAt) continue;
      const distance = Math.hypot(
        ...command.pose.position.map((v, i) => v - frame.pose.position[i]),
      );
      const angle = Math.max(...command.pose.rotationDeg.map((v, i) => {
        const delta = (v - frame.pose.rotationDeg[i]) * Math.PI / 180;
        return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) * 180 / Math.PI;
      }));
      if (distance <= 0.002 && angle <= 0.15) {
        command.frame = frame;
        break;
      }
    }
  }

  swapped(revision: number, at: number) {
    for (const [sequence, command] of this.commands) {
      const frame = command.frame;
      if (!frame || frame.revision !== revision) continue;
      this.samples.push({
        sequence,
        commandToCaptureMs: frame.capturedAt - command.sentAt,
        commandToSourceMs: frame.sourceCapturedAt == null
          ? null
          : frame.sourceCapturedAt - command.sentAt,
        sourceToArrivalMs: frame.sourceCapturedAt == null
          ? null
          : frame.capturedAt - frame.sourceCapturedAt,
        captureToDecodeMs: frame.decodedAt == null ? null : frame.decodedAt - frame.capturedAt,
        decodeToDeliveryMs: frame.decodedAt == null ? null : frame.deliveredAt - frame.decodedAt,
        prepareMs: frame.preparedAt - frame.deliveredAt,
        prepareToSwapMs: at - frame.preparedAt,
        commandAckMs: command.ackAt == null ? null : command.ackAt - command.sentAt,
        totalMs: at - command.sentAt,
      });
      this.commands.delete(sequence);
    }
    if (this.samples.length > 128) this.samples.splice(0, this.samples.length - 128);
  }

  report() {
    const keys = [
      "commandToCaptureMs",
      "commandToSourceMs",
      "sourceToArrivalMs",
      "captureToDecodeMs",
      "decodeToDeliveryMs",
      "prepareMs",
      "prepareToSwapMs",
      "commandAckMs",
      "totalMs",
    ] as const;
    const summary = Object.fromEntries(keys.map((key) => {
      const values = this.samples.map((sample) => sample[key]).filter((v): v is number =>
        v != null && Number.isFinite(v)
      ).sort((a, b) => a - b);
      return [key, {
        count: values.length,
        median: values.length ? values[Math.floor(values.length / 2)] : null,
        p90: values.length
          ? values[Math.min(values.length - 1, Math.floor(values.length * 0.9))]
          : null,
      }];
    }));
    return {
      samples: this.samples.slice(),
      summary,
      pending: this.commands.size,
      expired: this.expired,
      endpoint:
        "after raylib EndDrawing/window swap; excludes desktop compositor and display scanout",
      matching:
        "first presented fresh pose within 2 mm and 0.15 degrees; skipped commands are unmatched",
    };
  }
}
