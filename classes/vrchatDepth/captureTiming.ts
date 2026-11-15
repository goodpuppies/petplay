/** Bounded correlation of showinfo frame numbers with x11grab's wall-clock PTS (-copyts). */
export class CaptureTiming {
  private partial = "";
  private timestamps = new Map<number, number>();

  feed(text: string): string[] {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop()!.slice(-4096);
    for (const line of lines) {
      if (!line.includes("showinfo")) continue;
      const match = /\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*([\d.e+-]+)/.exec(line);
      if (!match) continue;
      const at = Number(match[2]) * 1000;
      // Reject relative timestamps: only wall-clock PTS is comparable with Date.now().
      if (!Number.isFinite(at) || at < 1e12) continue;
      this.timestamps.set(Number(match[1]), at);
      if (this.timestamps.size > 128) this.timestamps.delete(this.timestamps.keys().next().value!);
    }
    return lines;
  }

  take(frame: number): number | undefined {
    const at = this.timestamps.get(frame);
    this.timestamps.delete(frame);
    return at;
  }
}
