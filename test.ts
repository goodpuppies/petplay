import { python, kw } from "https://deno.land/x/python/mod.ts";

console.time("Total execution time");

const np = python.import("numpy");

console.time("Generate image in Python");
// Simulate a Python memoryview object
const image = np.random.randint(0, 256, [2048, 2048], kw`dtype=${"uint8"}`);
console.timeEnd("Generate image in Python");

console.time("Create memoryview in Python");
const memoryView = python.builtins.memoryview(image);
console.timeEnd("Create memoryview in Python");

console.time("Transfer to Deno Uint8Array");
// Use Deno's UnsafePointerView to map the memory
const buffer = new Uint8Array(memoryView.tobytes().buffer);
console.timeEnd("Transfer to Deno Uint8Array");

console.log("Received image buffer in Deno (length):", buffer.length);

console.timeEnd("Total execution time");
