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
      const readySlot = this.selectNewestReadySlot(
        this.slots.filter((candidate) => candidate.inFlight),
      );
      return readySlot ? await this.mapSlot(readySlot, format, 0) : null;
    }

    this.enqueueCopy(slot, texture, width, height, layer);

    const pendingSlots = this.slots.filter((candidate) => candidate.inFlight);
    if (pendingSlots.length < Math.min(this.ringSize, 2)) {
      return null;
    }

    const readyCandidates = pendingSlots.filter((candidate) => candidate !== slot);
    if (readyCandidates.length === 0) {
      return null;
    }

    const immediatelyReadySlot = this.selectNewestReadySlot(readyCandidates);
    if (immediatelyReadySlot) {
      return await this.mapSlot(immediatelyReadySlot, format, 0);
    }

    const readySignalStartedAt = performance.now();
    await Promise.race(
      readyCandidates
        .map((candidate) => candidate.readyPromise)
        .filter((promise): promise is Promise<void> => promise !== null),
    );
    const readySignalWaitMs = performance.now() - readySignalStartedAt;

    const newestReadySlot = this.selectNewestReadySlot(readyCandidates);
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
      submissionId: 0,
    };
  }

  private selectNewestReadySlot(candidates: ReadbackSlot[]): ReadbackSlot | null {
    return candidates
      .filter((candidate) => candidate.ready)
      .sort((left, right) => right.submissionId - left.submissionId)[0] ?? null;
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
    slot.submissionId = this.nextSubmissionId++;
    this.device.queue.submit([encoder.finish()]);
    slot.readyPromise = slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      slot.ready = true;
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
    const queueAgeMs = performance.now() - slot.submittedAt;

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
      mapRangeMs,
      arrayBuffer,
      rawPointer,
      unmap: release,
      destroy: release,
    };
  }
}

export { assert };
