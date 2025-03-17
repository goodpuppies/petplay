// Function to flip texture data vertically
export function flipVertical(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const flippedPixels = new Uint8Array(pixels.length);
  const bytesPerRow = width * 4;
  for (let y = 0; y < height; y++) {
    const srcRowStart = y * bytesPerRow;
    const destRowStart = (height - 1 - y) * bytesPerRow;
    flippedPixels.set(pixels.slice(srcRowStart, srcRowStart + bytesPerRow), destRowStart);
  }
  return flippedPixels;
}
