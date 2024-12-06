const sizeMB = 8;
const sizeBytes = sizeMB * 1024 * 1024;

// Measure time for Uint8Array creation
const startTime = performance.now();
const uint8Array = new Uint8Array(sizeBytes);
const endTime = performance.now();

console.log(`Time to create ${sizeMB}MB Uint8Array: ${(endTime - startTime).toFixed(6)} ms`);
