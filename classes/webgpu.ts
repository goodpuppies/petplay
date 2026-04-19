function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function alignTo256(value: number): number {
  return Math.ceil(value / 256) * 256;
}

export type NonBlackPixelReport = {
  avgLuma: number;
  maxChannel: number;
  nonZeroSamples: number;
  sampleCount: number;
  width: number;
  height: number;
  layer: number;
  isNonBlack: boolean;
};

export type OverlayUploadFormat = "rgba" | "bgra";

export type MappedTextureReadback = {
  width: number;
  height: number;
  bytesPerRow: number;
  format: OverlayUploadFormat;
  readySignalWaitMs: number;
  readbackWaitMs: number;
  queueAgeMs: number;
  gpuReadyMs: number;
  shelfMs: number;
  mapRangeMs: number;
  arrayBuffer: ArrayBuffer;
  rawPointer: Deno.PointerValue;
  unmap: () => void;
  destroy: () => void;
};

export type StereoMappedTextureReadback = {
  left: MappedTextureReadback;
  right: MappedTextureReadback;
  lookRotation: Float32Array;
  halfFovInRadians: number;
  outputWidth: number;
  outputHeight: number;
  unmap: () => void;
  destroy: () => void;
};

export function combineStereoReadbacksToSbs(
  left: MappedTextureReadback,
  right: MappedTextureReadback,
  format: OverlayUploadFormat = left.format,
): MappedTextureReadback {
  assert(left.width === right.width, "Stereo readback widths do not match");
  assert(left.height === right.height, "Stereo readback heights do not match");

  const width = left.width + right.width;
  const height = left.height;
  const bytesPerPixel = 4;
  const bytesPerRow = width * bytesPerPixel;
  const arrayBuffer = new ArrayBuffer(bytesPerRow * height);
  const destination = new Uint8Array(arrayBuffer);
  const leftBytes = new Uint8Array(left.arrayBuffer);
  const rightBytes = new Uint8Array(right.arrayBuffer);
  const halfRowBytes = left.width * bytesPerPixel;

  for (let y = 0; y < height; y++) {
    const dstOffset = y * bytesPerRow;
    const leftOffset = y * left.bytesPerRow;
    const rightOffset = y * right.bytesPerRow;
    destination.set(leftBytes.subarray(leftOffset, leftOffset + halfRowBytes), dstOffset);
    destination.set(
      rightBytes.subarray(rightOffset, rightOffset + halfRowBytes),
      dstOffset + halfRowBytes,
    );
  }

  const rawPointer = Deno.UnsafePointer.of(arrayBuffer);
  assert(rawPointer, "Failed to obtain pointer for combined stereo readback");

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    left.destroy();
    right.destroy();
  };

  return {
    width,
    height,
    bytesPerRow,
    format,
    readySignalWaitMs: Math.max(left.readySignalWaitMs, right.readySignalWaitMs),
    readbackWaitMs: Math.max(left.readbackWaitMs, right.readbackWaitMs),
    queueAgeMs: Math.max(left.queueAgeMs, right.queueAgeMs),
    gpuReadyMs: Math.max(left.gpuReadyMs, right.gpuReadyMs),
    shelfMs: Math.max(left.shelfMs, right.shelfMs),
    mapRangeMs: Math.max(left.mapRangeMs, right.mapRangeMs),
    arrayBuffer,
    rawPointer,
    unmap: release,
    destroy: release,
  };
}

type ReadbackSlot = {
  buffer: GPUBuffer;
  size: number;
  bytesPerRow: number;
  width: number;
  height: number;
  inFlight: boolean;
  readyPromise: Promise<void> | null;
  ready: boolean;
  submittedAt: number;
  readyAt: number;
  submissionId: number;
};

function analyzeReadback(
  data: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  sampleColumns = 16,
  sampleRows = 16,
): NonBlackPixelReport {
  const columns = Math.min(width, sampleColumns);
  const rows = Math.min(height, sampleRows);
  let totalLuma = 0;
  let maxChannel = 0;
  let nonZeroSamples = 0;
  let sampleCount = 0;

  for (let yIndex = 0; yIndex < rows; yIndex++) {
    const y = Math.floor((yIndex * height) / rows);
    for (let xIndex = 0; xIndex < columns; xIndex++) {
      const x = Math.floor((xIndex * width) / columns);
      const offset = (y * bytesPerRow) + (x * 4);
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const luma = (r + g + b) / 3;
      totalLuma += luma;
      maxChannel = Math.max(maxChannel, r, g, b);
      if (r !== 0 || g !== 0 || b !== 0) {
        nonZeroSamples++;
      }
      sampleCount++;
    }
  }

  const avgLuma = sampleCount > 0 ? totalLuma / sampleCount : 0;

  return {
    avgLuma,
    maxChannel,
    nonZeroSamples,
    sampleCount,
    width,
    height,
    layer: 0,
    isNonBlack: nonZeroSamples > 0 && maxChannel > 2 && avgLuma > 0.5,
  };
}

export async function inspectTextureForNonBlackPixels(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  layer = 0,
): Promise<NonBlackPixelReport> {
  const bytesPerRow = alignTo256(width * 4);
  const size = bytesPerRow * height;

  const buffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    {
      texture,
      origin: { x: 0, y: 0, z: layer },
    },
    {
      buffer,
      bytesPerRow,
      rowsPerImage: height,
    },
    {
      width,
      height,
      depthOrArrayLayers: 1,
    },
  );

  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);

  const mapped = new Uint8Array(buffer.getMappedRange());
  const report = analyzeReadback(mapped, width, height, bytesPerRow);
  report.layer = layer;

  buffer.unmap();
  buffer.destroy();

  return report;
}

export class TextureReadbackRing {
  private readonly slots: ReadbackSlot[] = [];
  private nextSlotIndex = 0;
  private nextSubmissionId = 1;

  constructor(
    private readonly device: GPUDevice,
    private readonly ringSize = 3,
  ) {}

  async capture(
    texture: GPUTexture,
    width: number,
    height: number,
    layer = 0,
    format: OverlayUploadFormat = "rgba",
  ): Promise<MappedTextureReadback | null> {
    const slot = this.acquireFreeSlot(width, height);
    if (!slot) {
      const readySlot = this.selectNewestReadyInFlightSlot();
      return readySlot ? await this.mapSlot(readySlot, format, 0) : null;
    }

    this.enqueueCopy(slot, texture, width, height, layer);

    const minimumPendingSlots = Math.min(this.ringSize, 2);
    let pendingSlotCount = 0;
    for (const candidate of this.slots) {
      if (candidate?.inFlight) {
        pendingSlotCount++;
      }
    }
    if (pendingSlotCount < minimumPendingSlots) {
      return null;
    }

    const immediatelyReadySlot = this.selectNewestReadyInFlightSlot(slot);
    if (immediatelyReadySlot) {
      return await this.mapSlot(immediatelyReadySlot, format, 0);
    }

    const readyPromises: Promise<void>[] = [];
    for (const candidate of this.slots) {
      if (!candidate || candidate === slot || !candidate.inFlight || candidate.readyPromise === null) {
        continue;
      }
      readyPromises.push(candidate.readyPromise);
    }
    if (readyPromises.length === 0) {
      return null;
    }

    const readySignalStartedAt = performance.now();
    await Promise.race(readyPromises);
    const readySignalWaitMs = performance.now() - readySignalStartedAt;

    const newestReadySlot = this.selectNewestReadyInFlightSlot(slot);
    if (!newestReadySlot) {
      return null;
    }

    return await this.mapSlot(newestReadySlot, format, readySignalWaitMs);
  }

  cleanup() {
    for (const slot of this.slots) {
      try {
        slot.buffer.unmap();
      } catch {
        // Ignore already-unmapped buffers.
      }
      slot.buffer.destroy();
    }
    this.slots.length = 0;
    this.nextSlotIndex = 0;
  }

  private acquireFreeSlot(width: number, height: number): ReadbackSlot | null {
    const bytesPerRow = alignTo256(width * 4);
    const size = bytesPerRow * height;

    for (let attempt = 0; attempt < this.ringSize; attempt++) {
      const slotIndex = (this.nextSlotIndex + attempt) % this.ringSize;
      let slot = this.slots[slotIndex];

      if (!slot) {
        slot = this.createSlot(width, height, bytesPerRow, size);
        this.slots[slotIndex] = slot;
      } else if (
        !slot.inFlight && (slot.size !== size || slot.width !== width || slot.height !== height)
      ) {
        slot.buffer.destroy();
        slot = this.createSlot(width, height, bytesPerRow, size);
        this.slots[slotIndex] = slot;
      }

      if (!slot.inFlight) {
        this.nextSlotIndex = (slotIndex + 1) % this.ringSize;
        return slot;
      }
    }

    return null;
  }

  private createSlot(
    width: number,
    height: number,
    bytesPerRow: number,
    size: number,
  ): ReadbackSlot {
    return {
      buffer: this.device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      size,
      bytesPerRow,
      width,
      height,
      inFlight: false,
      readyPromise: null,
      ready: false,
      submittedAt: 0,
      readyAt: 0,
      submissionId: 0,
    };
  }

  private selectNewestReadyInFlightSlot(excludedSlot?: ReadbackSlot): ReadbackSlot | null {
    let newestReadySlot: ReadbackSlot | null = null;
    for (const candidate of this.slots) {
      if (
        !candidate || candidate === excludedSlot || !candidate.inFlight || !candidate.ready
      ) {
        continue;
      }
      if (!newestReadySlot || candidate.submissionId > newestReadySlot.submissionId) {
        newestReadySlot = candidate;
      }
    }
    return newestReadySlot;
  }

  private enqueueCopy(
    slot: ReadbackSlot,
    texture: GPUTexture,
    width: number,
    height: number,
    layer: number,
  ) {
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      {
        texture,
        origin: { x: 0, y: 0, z: layer },
      },
      {
        buffer: slot.buffer,
        bytesPerRow: slot.bytesPerRow,
        rowsPerImage: height,
      },
      {
        width,
        height,
        depthOrArrayLayers: 1,
      },
    );

    slot.inFlight = true;
    slot.ready = false;
    slot.width = width;
    slot.height = height;
    slot.submittedAt = performance.now();
    slot.readyAt = 0;
    slot.submissionId = this.nextSubmissionId++;
    this.device.queue.submit([encoder.finish()]);
    slot.readyPromise = slot.buffer.mapAsync(GPUMapMode.READ)
      .then(() => {
        slot.readyAt = performance.now();
        slot.ready = true;
      })
      .catch((err) => {
        console.warn("[WEBGPU] [readback] mapAsync rejected, poisoning slot:", err);
        slot.inFlight = false;
        slot.ready = false;
        slot.readyPromise = null;
        // Force recreation on next acquireFreeSlot by invalidating size.
        slot.size = -1;
        try {
          slot.buffer.destroy();
        } catch (_) {
          // Already destroyed or unusable; acquireFreeSlot will replace it.
        }
        throw err;
      });
  }

  private async mapSlot(
    slot: ReadbackSlot,
    format: OverlayUploadFormat,
    readySignalWaitMs: number,
  ): Promise<MappedTextureReadback> {
    assert(slot.readyPromise, "Readback slot was not scheduled");
    const waitStartedAt = performance.now();
    await slot.readyPromise;
    const readbackWaitMs = performance.now() - waitStartedAt;
    const now = performance.now();
    const queueAgeMs = now - slot.submittedAt;
    const gpuReadyMs = slot.readyAt > 0 ? slot.readyAt - slot.submittedAt : queueAgeMs;
    const shelfMs = slot.readyAt > 0 ? Math.max(0, now - slot.readyAt) : 0;

    const mapRangeStartedAt = performance.now();
    const arrayBuffer = slot.buffer.getMappedRange();
    const rawPointer = Deno.UnsafePointer.of(arrayBuffer);
    const mapRangeMs = performance.now() - mapRangeStartedAt;
    assert(rawPointer, "Failed to obtain pointer for mapped GPU buffer");

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      try {
        slot.buffer.unmap();
      } catch {
        // Another release path may have already unmapped this buffer.
      }
      slot.inFlight = false;
      slot.readyPromise = null;
      slot.ready = false;
      slot.submittedAt = 0;
      slot.submissionId = 0;
    };

    return {
      width: slot.width,
      height: slot.height,
      bytesPerRow: slot.bytesPerRow,
      format,
      readySignalWaitMs,
      readbackWaitMs,
      queueAgeMs,
      gpuReadyMs,
      shelfMs,
      mapRangeMs,
      arrayBuffer,
      rawPointer,
      unmap: release,
      destroy: release,
    };
  }
}

type StereoReadbackSlot = {
  buffer: GPUBuffer;
  perEyeBytes: number;
  totalBytes: number;
  bytesPerRow: number;
  width: number;
  height: number;
  inFlight: boolean;
  readyPromise: Promise<void> | null;
  ready: boolean;
  submittedAt: number;
  readyAt: number;
  submissionId: number;
};

export class StereoTextureReadbackRing {
  private readonly slots: StereoReadbackSlot[] = [];
  private nextSlotIndex = 0;
  private nextSubmissionId = 1;

  constructor(
    private readonly device: GPUDevice,
    private readonly ringSize = 3,
  ) {}

  async capture(
    texture: GPUTexture,
    width: number,
    height: number,
    format: OverlayUploadFormat = "rgba",
    syncAwaitSelf = false,
  ): Promise<StereoMappedTextureReadback | null> {
    const slot = this.acquireFreeSlot(width, height);
    if (!slot) {
      const readySlot = this.selectNewestReadyInFlightSlot();
      return readySlot ? await this.mapSlot(readySlot, format, 0) : null;
    }

    this.enqueueCopy(slot, texture, width, height);

    if (syncAwaitSelf) {
      // Debug: await THIS submission's own mapAsync to measure the true
      // submit -> ready latency of a freshly submitted copy, bypassing the
      // newest-ready ring policy.
      return await this.mapSlot(slot, format, 0);
    }

    const minimumPendingSlots = Math.min(this.ringSize, 2);
    let pendingSlotCount = 0;
    for (const candidate of this.slots) {
      if (candidate?.inFlight) {
        pendingSlotCount++;
      }
    }
    if (pendingSlotCount < minimumPendingSlots) {
      return null;
    }

    const immediatelyReadySlot = this.selectNewestReadyInFlightSlot(slot);
    if (immediatelyReadySlot) {
      return await this.mapSlot(immediatelyReadySlot, format, 0);
    }

    const readyPromises: Promise<void>[] = [];
    for (const candidate of this.slots) {
      if (
        !candidate || candidate === slot || !candidate.inFlight ||
        candidate.readyPromise === null
      ) {
        continue;
      }
      readyPromises.push(candidate.readyPromise);
    }
    if (readyPromises.length === 0) {
      return null;
    }

    const readySignalStartedAt = performance.now();
    await Promise.race(readyPromises);
    const readySignalWaitMs = performance.now() - readySignalStartedAt;

    const newestReadySlot = this.selectNewestReadyInFlightSlot(slot);
    if (!newestReadySlot) {
      return null;
    }

    return await this.mapSlot(newestReadySlot, format, readySignalWaitMs);
  }

  cleanup() {
    for (const slot of this.slots) {
      try {
        slot.buffer.unmap();
      } catch {
        // Ignore already-unmapped buffers.
      }
      slot.buffer.destroy();
    }
    this.slots.length = 0;
    this.nextSlotIndex = 0;
  }

  private acquireFreeSlot(width: number, height: number): StereoReadbackSlot | null {
    const bytesPerRow = alignTo256(width * 4);
    const perEyeBytes = bytesPerRow * height;
    const totalBytes = perEyeBytes * 2;

    for (let attempt = 0; attempt < this.ringSize; attempt++) {
      const slotIndex = (this.nextSlotIndex + attempt) % this.ringSize;
      let slot = this.slots[slotIndex];

      if (!slot) {
        slot = this.createSlot(width, height, bytesPerRow, perEyeBytes, totalBytes);
        this.slots[slotIndex] = slot;
      } else if (
        !slot.inFlight &&
        (slot.totalBytes !== totalBytes || slot.width !== width || slot.height !== height)
      ) {
        slot.buffer.destroy();
        slot = this.createSlot(width, height, bytesPerRow, perEyeBytes, totalBytes);
        this.slots[slotIndex] = slot;
      }

      if (!slot.inFlight) {
        this.nextSlotIndex = (slotIndex + 1) % this.ringSize;
        return slot;
      }
    }

    return null;
  }

  private createSlot(
    width: number,
    height: number,
    bytesPerRow: number,
    perEyeBytes: number,
    totalBytes: number,
  ): StereoReadbackSlot {
    return {
      buffer: this.device.createBuffer({
        size: totalBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      perEyeBytes,
      totalBytes,
      bytesPerRow,
      width,
      height,
      inFlight: false,
      readyPromise: null,
      ready: false,
      submittedAt: 0,
      readyAt: 0,
      submissionId: 0,
    };
  }

  private selectNewestReadyInFlightSlot(
    excludedSlot?: StereoReadbackSlot,
  ): StereoReadbackSlot | null {
    let newestReadySlot: StereoReadbackSlot | null = null;
    for (const candidate of this.slots) {
      if (
        !candidate || candidate === excludedSlot || !candidate.inFlight || !candidate.ready
      ) {
        continue;
      }
      if (!newestReadySlot || candidate.submissionId > newestReadySlot.submissionId) {
        newestReadySlot = candidate;
      }
    }
    return newestReadySlot;
  }

  private enqueueCopy(
    slot: StereoReadbackSlot,
    texture: GPUTexture,
    width: number,
    height: number,
  ) {
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      {
        texture,
        origin: { x: 0, y: 0, z: 0 },
      },
      {
        buffer: slot.buffer,
        offset: 0,
        bytesPerRow: slot.bytesPerRow,
        rowsPerImage: height,
      },
      {
        width,
        height,
        depthOrArrayLayers: 1,
      },
    );
    encoder.copyTextureToBuffer(
      {
        texture,
        origin: { x: 0, y: 0, z: 1 },
      },
      {
        buffer: slot.buffer,
        offset: slot.perEyeBytes,
        bytesPerRow: slot.bytesPerRow,
        rowsPerImage: height,
      },
      {
        width,
        height,
        depthOrArrayLayers: 1,
      },
    );

    slot.inFlight = true;
    slot.ready = false;
    slot.width = width;
    slot.height = height;
    slot.submittedAt = performance.now();
    slot.readyAt = 0;
    slot.submissionId = this.nextSubmissionId++;
    this.device.queue.submit([encoder.finish()]);
    slot.readyPromise = slot.buffer.mapAsync(GPUMapMode.READ)
      .then(() => {
        slot.readyAt = performance.now();
        slot.ready = true;
      })
      .catch((err) => {
        console.warn("[WEBGPU] [stereo-readback] mapAsync rejected, poisoning slot:", err);
        slot.inFlight = false;
        slot.ready = false;
        slot.readyPromise = null;
        // Force recreation on next acquireFreeSlot by invalidating totalBytes.
        slot.totalBytes = -1;
        try {
          slot.buffer.destroy();
        } catch (_) {
          // Already destroyed or unusable; acquireFreeSlot will replace it.
        }
        throw err;
      });
  }

  private async mapSlot(
    slot: StereoReadbackSlot,
    format: OverlayUploadFormat,
    readySignalWaitMs: number,
  ): Promise<StereoMappedTextureReadback> {
    assert(slot.readyPromise, "Stereo readback slot was not scheduled");
    const waitStartedAt = performance.now();
    await slot.readyPromise;
    const readbackWaitMs = performance.now() - waitStartedAt;
    const nowAfterReady = performance.now();
    const queueAgeMs = nowAfterReady - slot.submittedAt;
    const gpuReadyMs = slot.readyAt > 0 ? slot.readyAt - slot.submittedAt : queueAgeMs;
    const shelfMs = slot.readyAt > 0 ? Math.max(0, nowAfterReady - slot.readyAt) : 0;

    const mapRangeStartedAt = performance.now();
    // Use sub-range getMappedRange() per eye so the returned ArrayBuffers are
    // aliased to exact left/right regions. This removes the need for manual
    // pointer arithmetic (Deno.UnsafePointer.create(value + perEyeBytes)) and
    // lets Deno.UnsafePointer.of() produce eye-local pointers directly.
    const leftArrayBuffer = slot.buffer.getMappedRange(0, slot.perEyeBytes);
    const rightArrayBuffer = slot.buffer.getMappedRange(
      slot.perEyeBytes,
      slot.perEyeBytes,
    );
    const leftPointer = Deno.UnsafePointer.of(leftArrayBuffer);
    const rightPointer = Deno.UnsafePointer.of(rightArrayBuffer);
    assert(leftPointer, "Failed to obtain pointer for left-eye mapped range");
    assert(rightPointer, "Failed to obtain pointer for right-eye mapped range");
    const mapRangeMs = performance.now() - mapRangeStartedAt;

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      try {
        slot.buffer.unmap();
      } catch {
        // Another release path may have already unmapped this buffer.
      }
      slot.inFlight = false;
      slot.readyPromise = null;
      slot.ready = false;
      slot.submittedAt = 0;
      slot.submissionId = 0;
    };

    const leftReadback: MappedTextureReadback = {
      width: slot.width,
      height: slot.height,
      bytesPerRow: slot.bytesPerRow,
      format,
      readySignalWaitMs,
      readbackWaitMs,
      queueAgeMs,
      gpuReadyMs,
      shelfMs,
      mapRangeMs,
      arrayBuffer: leftArrayBuffer,
      rawPointer: leftPointer,
      unmap: release,
      destroy: release,
    };
    const rightReadback: MappedTextureReadback = {
      width: slot.width,
      height: slot.height,
      bytesPerRow: slot.bytesPerRow,
      format,
      readySignalWaitMs,
      readbackWaitMs,
      queueAgeMs,
      gpuReadyMs,
      shelfMs,
      mapRangeMs: 0,
      arrayBuffer: rightArrayBuffer,
      rawPointer: rightPointer,
      unmap: release,
      destroy: release,
    };

    return {
      left: leftReadback,
      right: rightReadback,
      lookRotation: new Float32Array(16),
      halfFovInRadians: 0,
      outputWidth: slot.width * 2,
      outputHeight: slot.width * 2,
      unmap: release,
      destroy: release,
    };
  }
}

export { assert };
