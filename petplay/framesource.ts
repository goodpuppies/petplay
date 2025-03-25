import { PostMan } from "../submodules/stageforge/mod.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { ScreenCapturer } from "../classes/ScreenCapturer/scclass.ts";
import { wait } from "../classes/utils.ts";

interface frame { 
  pixels: Uint8Array,
  width: number,
  height: number
}

const state = {
  id: "",
  name: "desktop",
  screenCapturer: null as ScreenCapturer | null,
  isRunning: false,
  currentFrame: null as frame | null
};

new PostMan(state, {
  CUSTOMINIT: (_payload: void) => { main() },
  GETFRAME: (_payload: void): frame | null => {
    if (state.currentFrame == null) { return null}
    return state.currentFrame
  },
} as const);

function INITSCREENCAP(): ScreenCapturer {
  const capturer = new ScreenCapturer({
    debug: false,
    onStats: ({ fps, avgLatency }) => {
      CustomLogger.log("screencap", `Capture Stats - FPS: ${fps.toFixed(1)} | Latency: ${avgLatency.toFixed(1)}ms`);
    },
    executablePath: "../resources/screen-streamer"
  });
  return capturer;
}

async function main() {

  const screenCapturer = INITSCREENCAP();
  state.isRunning = true;

  while (state.isRunning) { 
    const frame = await screenCapturer.getLatestFrame();
    if (frame === null) { await wait(1000); console.log("no frame"); continue }
    state.currentFrame = {
      pixels: frame.data,
      width: frame.width,
      height: frame.height
    }
    await wait(0)
  }
}

globalThis.addEventListener("unload", cleanup);

async function cleanup() {
  state.isRunning = false;
  if (state.screenCapturer) {
    await state.screenCapturer.dispose();
    state.screenCapturer = null;
  }
}


