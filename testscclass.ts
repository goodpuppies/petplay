import { ScreenCapture } from "./ScreenCapture.ts";

const screen = new ScreenCapture();

// Sample a few pixel positions to monitor
const pixelPositions = [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
    { x: 300, y: 300 }
];

function getPixelRGB(pixels: Uint8Array, width: number, x: number, y: number) {
    const index = (y * width + x) * 4;
    return {
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2],
        a: pixels[index + 3]
    };
}

let lastPixels: { [key: string]: any } = {};

function monitorPixels() {
    const { pixels, width, height } = screen.getCurrentFrame();
    
    if (width === 0 || height === 0) {
        console.log("No frame data yet...");
        return;
    }

    let pixelsChanged = false;
    
    pixelPositions.forEach(({x, y}) => {
        if (x < width && y < height) {
            const rgb = getPixelRGB(pixels, width, x, y);
            const key = `${x},${y}`;
            
            // Check if pixel changed from last time
            if (!lastPixels[key] || 
                lastPixels[key].r !== rgb.r || 
                lastPixels[key].g !== rgb.g || 
                lastPixels[key].b !== rgb.b) {
                
                pixelsChanged = true;
                lastPixels[key] = rgb;
                console.log(`Pixel at (${x}, ${y}): R:${rgb.r} G:${rgb.g} B:${rgb.b}`);
            }
        }
    });

    if (!pixelsChanged) {
        console.log("No pixel changes detected");
    }
}

console.log("Starting screen capture test...");
screen.start();

// Monitor pixels every 500ms
setInterval(monitorPixels, 500);

// Handle cleanup on exit
globalThis.addEventListener("unload", () => {
    screen.stop();
});
