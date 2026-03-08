export type IntervalMetricSample = {
  avgMs: number;
  maxMs: number;
  count: number;
};

export class IntervalMetric {
  private totalMs = 0;
  private maxMs = 0;
  private count = 0;

  record(durationMs: number) {
    this.totalMs += durationMs;
    this.maxMs = Math.max(this.maxMs, durationMs);
    this.count++;
  }

  flush(): IntervalMetricSample | null {
    if (this.count === 0) {
      return null;
    }

    const sample = {
      avgMs: this.totalMs / this.count,
      maxMs: this.maxMs,
      count: this.count,
    };

    this.totalMs = 0;
    this.maxMs = 0;
    this.count = 0;

    return sample;
  }

  reset() {
    this.totalMs = 0;
    this.maxMs = 0;
    this.count = 0;
  }
}
