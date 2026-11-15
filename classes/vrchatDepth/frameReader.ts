/** Read directly into one frame buffer instead of allocating/copying every pipe chunk.
 * The callback is synchronous; the next BYOB read transfers and reuses its backing storage.
 */
export async function readFrameBytes(
  stream: ReadableStream<Uint8Array>,
  size: number,
  onFrame: (bytes: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader({ mode: "byob" });
  let frame = new Uint8Array(size);
  let filled = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(frame.subarray(filled));
      if (done) break;
      // BYOB transfers the backing ArrayBuffer; rebuild the full view with its previous prefix.
      frame = new Uint8Array(value.buffer);
      filled += value.byteLength;
      if (filled === size) {
        onFrame(frame);
        filled = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
