export function splitSBSTexture(
  pixels: Uint8Array,
  width: number,
  height: number,
  leftOutput: Uint8Array,
  rightOutput: Uint8Array
): void {
  //console.log(`[WebUpdater] splitSBSTexture: Received sourceBuffer type=${typeof pixels}, length=${pixels?.byteLength}`); // DEBUG

  if (!pixels) {
    console.error("splitSBSTexture received undefined sourceBuffer!");
    throw new Error("splitSBSTexture received undefined sourceBuffer!"); // Let's make it throw
  }

  const eyeWidth = width / 2;
  const eyeHeight = height;
  const eyeByteWidth = eyeWidth * 4; // Assuming RGBA format (4 bytes per pixel)
  const totalByteWidth = width * 4;
  const expectedEyeSize = eyeWidth * eyeHeight * 4;

  if (leftOutput.byteLength !== expectedEyeSize || rightOutput.byteLength !== expectedEyeSize) {
    throw new Error(`Output buffer size mismatch. Expected ${expectedEyeSize}, got Left: ${leftOutput.byteLength}, Right: ${rightOutput.byteLength}`);
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * totalByteWidth;
    const destRowOffset = y * eyeByteWidth;

    // Copy left half directly into leftOutput
    leftOutput.set(pixels.subarray(rowOffset, rowOffset + eyeByteWidth), destRowOffset);
    // Copy right half directly into rightOutput
    rightOutput.set(pixels.subarray(rowOffset + eyeByteWidth, rowOffset + totalByteWidth), destRowOffset);
  }
}

