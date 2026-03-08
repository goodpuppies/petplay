export class FpsCounter {
  private lastSampleAt = 0;
  private framesSinceSample = 0;
  private currentFps = 0;

  mark(now = performance.now()) {
    if (this.lastSampleAt === 0) {
      this.lastSampleAt = now;
      this.framesSinceSample = 1;
      return;
    }

    this.framesSinceSample++;
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 1000) {
      return;
    }

    this.currentFps = (this.framesSinceSample * 1000) / elapsed;
    this.framesSinceSample = 0;
    this.lastSampleAt = now;
  }

  reset() {
    this.lastSampleAt = 0;
    this.framesSinceSample = 0;
    this.currentFps = 0;
  }

  getFps() {
    return this.currentFps;
  }
}
