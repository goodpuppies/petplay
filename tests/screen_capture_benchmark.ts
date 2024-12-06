import { python } from "https://deno.land/x/python/mod.ts";

async function testScreenCapture() {
    console.log("Starting screen capture benchmark...");
    
    const mss = python.import("mss");
    const np = python.import("numpy");
    const sct = new mss.mss();
    const monitor = sct.monitors[1];  // Primary monitor
    const width = monitor.width;
    const height = monitor.height;
    const totalBytes = width * height * 4;  // BGRA format
    
    console.log(`Setting up buffers for ${width} x ${height} screen`);
    console.log(`Total bytes: ${totalBytes}`);
    
    // Test different conversion methods
    console.log("\nTesting conversion methods:");
    
    // 1. Get screenshot
    const screenshot = sct.grab(monitor);
    const raw = screenshot.raw;
    
    // Method 1: Array.from (baseline)
    console.log("\n1. Array.from conversion:");
    const startArray = performance.now();
    const arrayData = Array.from(raw);
    const endArray = performance.now();
    console.log(`Array.from time: ${endArray - startArray} ms`);
    console.log("First few bytes:", arrayData.slice(0, 16));
    
    // Method 2: Numpy array
    console.log("\n2. Numpy array conversion:");
    const startNumpy = performance.now();
    // Convert to numpy array and get as list
    const npArray = np.frombuffer(raw, np.uint8);
    const listData = npArray.tolist();
    const endNumpy = performance.now();
    console.log(`Numpy conversion time: ${endNumpy - startNumpy} ms`);
    console.log("First few bytes:", listData.valueOf().slice(0, 16));
    
    // Method 3: Direct buffer copy (baseline)
    console.log("\n3. Direct buffer copy:");
    const buffer = new Uint8Array(totalBytes);
    const startCopy = performance.now();
    for (let i = 0; i < totalBytes; i++) {
        buffer[i] = raw[i];
    }
    const endCopy = performance.now();
    console.log(`Direct copy time: ${endCopy - startCopy} ms`);
    console.log("First few bytes:", buffer.slice(0, 16));
    
    // Method 4: Numpy batch conversion
    console.log("\n4. Numpy batch conversion:");
    const batchBuffer = new Uint8Array(totalBytes);
    const startBatch = performance.now();
    const batchSize = 1000;
    for (let i = 0; i < totalBytes; i += batchSize) {
        const end = Math.min(i + batchSize, totalBytes);
        const slice = raw.slice(i, end);
        // Convert slice to numpy array and get as list
        const npSlice = np.frombuffer(slice, np.uint8);
        const batchArray = npSlice.tolist().valueOf();
        if (Array.isArray(batchArray)) {
            batchBuffer.set(batchArray, i);
        }
    }
    const endBatch = performance.now();
    console.log(`Numpy batch time: ${endBatch - startBatch} ms`);
    console.log("First few bytes:", batchBuffer.slice(0, 16));
    
    // Clean up
    npArray.destroy?.();
    sct.close();
}

async function validateScreenCapture() {
    console.log("Starting screen capture validation...");
    
    const mss = python.import("mss");
    const sct = new mss.mss();
    
    // Log all monitors
    console.log("\nAvailable monitors:");
    for (const [idx, mon] of Object.entries(sct.monitors)) {
        console.log(`Monitor ${idx}:`, mon);
    }
    
    // Test primary monitor capture
    console.log("\nTesting primary monitor capture:");
    const monitor = sct.monitors[1];  // Primary monitor
    console.log("Selected monitor config:", monitor);
    
    try {
        console.log("Attempting screen capture...");
        const startCapture = performance.now();
        const screenshot = sct.grab(monitor);
        const endCapture = performance.now();
        
        // Get raw data info
        const raw = screenshot.raw;
        console.log("\nRaw data info:");
        console.log("Type:", typeof raw);
        console.log("Is array?", Array.isArray(raw));
        console.log("Properties:", Object.getOwnPropertyNames(raw));
        console.log("Prototype:", Object.getPrototypeOf(raw));
        
        // Try to get buffer info
        if (raw.__array_interface__) {
            console.log("\nArray interface:", raw.__array_interface__);
            const ptr = BigInt(raw.__array_interface__.data[0]);
            console.log("Data pointer:", ptr);
            
            // Try to create Deno pointer
            console.log("\nTrying direct pointer creation...");
            const startPtr = performance.now();
            const directPtr = Deno.UnsafePointer.create(ptr);
            const endPtr = performance.now();
            
            console.log("Direct pointer created in:", endPtr - startPtr, "ms");
            console.log("Pointer:", directPtr);
            
            // Try to read some data through pointer
            const view = new Deno.UnsafePointerView(directPtr);
            console.log("\nFirst few bytes through pointer:");
            const bytes = [];
            for (let i = 0; i < 16; i++) {
                bytes.push(view.getUint8(i));
            }
            console.log(bytes);
        }
        
        // Performance comparison
        console.log("\nPerformance comparison:");
        console.log(`Screen capture: ${endCapture - startCapture} ms`);
        
        // Test array conversion speed
        const startArray = performance.now();
        const asArray = Array.from(raw);
        const endArray = performance.now();
        console.log(`Array conversion: ${endArray - startArray} ms`);
        
        // Compare first few bytes
        console.log("\nFirst few bytes comparison:");
        console.log("Through Array.from:", asArray.slice(0, 16));
        
    } catch (err) {
        console.error("Error during capture:", err);
        if (err instanceof Error) {
            console.error("Stack:", err.stack);
        }
    } finally {
        sct.close();
    }
}

// Run the benchmark
await testScreenCapture().catch(console.error);

// Run the validation
await validateScreenCapture();
