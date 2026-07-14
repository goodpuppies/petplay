// Function to flip texture data vertically
export function flipVertical(
  pixels: Uint8Array,
  width: number,
  height: number,
  target = new Uint8Array(pixels.length),
): Uint8Array {
  if (target.length !== pixels.length) {
    throw new RangeError("flipVertical target size does not match the source");
  }
  const bytesPerRow = width * 4;
  for (let y = 0; y < height; y++) {
    const srcRowStart = y * bytesPerRow;
    const destRowStart = (height - 1 - y) * bytesPerRow;
    target.set(pixels.subarray(srcRowStart, srcRowStart + bytesPerRow), destRowStart);
  }
  return target;
}
