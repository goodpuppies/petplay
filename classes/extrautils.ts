export function splitSBSTexture(pixels: Uint8Array, width: number, height: number): { left: Uint8Array, right: Uint8Array } {
  //console.log(`[WebUpdater] splitSBSTexture: Received sourceBuffer type=${typeof pixels}, length=${pixels?.byteLength}`); // DEBUG
  
  if (!pixels) {
    console.error("splitSBSTexture received undefined sourceBuffer!");
    throw new Error("splitSBSTexture received undefined sourceBuffer!"); // Let's make it throw
  }
  
  const eyeWidth = width / 2;
  const eyeByteWidth = eyeWidth * 4; // Assuming RGBA format (4 bytes per pixel)
  const totalByteWidth = width * 4;
  const left = new Uint8Array(eyeWidth * height * 4);
  const right = new Uint8Array(eyeWidth * height * 4);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * totalByteWidth;
    const destRowOffset = y * eyeByteWidth;

    // Copy left half
    left.set(pixels.subarray(rowOffset, rowOffset + eyeByteWidth), destRowOffset);
    // Copy right half
    right.set(pixels.subarray(rowOffset + eyeByteWidth, rowOffset + totalByteWidth), destRowOffset);
  }
  return { left, right };
}