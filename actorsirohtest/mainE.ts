import { Message, TypedActorFunctions, BaseState, ToAddress, worker, type GenericActorFunctions } from "../actorsystem/types.ts";
import { OnMessage, Postman } from "../classes/PostMan.ts";
import { wait } from "../actorsystem/utils.ts";
import { CustomLogger } from "../classes/customlogger.ts";
import { python, kw } from "https://deno.land/x/python/mod.ts";
import type { Message as IrohMessage } from "@number0/iroh";

//main process

type State = {
  [key: string]: unknown;
};

const state: State & BaseState = {
  name: "main",
  id: "",
  addressBook: new Set()
};

export const functions = {
  MAIN: (payload: null) => {
    main(payload);
    Postman.functions.OPENPORTAL("muffin")
  },
  LOG: (_payload: null) => {
    CustomLogger.log("actor", state.id);
  },
  STDIN: (payload: string) => {
    CustomLogger.log("actor", "stdin:", payload);
  },
} as const;

function arrayToBase64(uint8Array: Uint8Array): string {
  const chunkSize = 32768; // 32KB chunks
  let base64 = '';
  
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.slice(i, i + chunkSize);
    base64 += String.fromCharCode.apply(null, chunk);
  }
  
  return btoa(base64);
}

async function sendScreenChunk(targetActor: string, width: number, height: number, data: string, chunkIndex: number, totalChunks: number) {
  Postman.PostMessage({
    address: {
      fm: state.id,
      to: targetActor
    },
    type: "SCREENDATA",
    payload: JSON.stringify({
      width,
      height,
      chunkIndex,
      totalChunks,
      data
    })
  });
}

async function captureAndSendScreen(targetActor: string) {
  try {
    const mss = python.import("mss");
    const np = python.import("numpy");
    const cv2 = python.import("cv2");
    const sct = new mss.mss();
    
    CustomLogger.log("default", "Screen capture initialized");
    
    // Capture the primary monitor
    const monitor = sct.monitors[1];
    const screenshot = sct.grab(monitor);
    
    // Convert to numpy array and resize to 720p
    let img_array = np.array(screenshot.raw);
    img_array = img_array.reshape(monitor.height, monitor.width, 4);
    
    // Convert to grayscale (if color isn't needed, comment this out if you need color)
    
    // Resize to a smaller resolution maintaining aspect ratio
    const target_height = 480; // Reduced from 720p to 480p
    const aspect_ratio = monitor.width / monitor.height;
    const target_width = Math.round(target_height * aspect_ratio);
    
    img_array = cv2.resize(img_array, [target_width, target_height], kw`interpolation=${cv2.INTER_AREA}`);
    
    // Convert to JPEG with lower quality for better compression
    const [success, encoded_img] = cv2.imencode(".jpg", img_array, [cv2.IMWRITE_JPEG_QUALITY, 40]);
    
    if (!success) {
      throw new Error("Failed to encode image");
    }
    
    // Convert encoded image to base64 using chunked conversion
    const uint8Array = new Uint8Array(encoded_img.asArray());
    const base64Data = arrayToBase64(uint8Array);
    
    CustomLogger.log("default", `Sending compressed screen data: ${base64Data.length} bytes`);

    Postman.PostMessage({
      address: {
        fm: state.id,
        to: targetActor
      },
      type: "SCREENDATA",
      payload: JSON.stringify({
        width: target_width,
        height: target_height,
        data: base64Data,
        format: "jpeg",
        grayscale: true
      })
    });
  } catch (err) {
    CustomLogger.log("default", "Error capturing screen:", err);
    if (err instanceof Error) {
      CustomLogger.log("default", "Error stack:", err.stack);
    }
  }
}

async function main(_payload: unknown) {
  const dummy = await Postman.create("dummy.ts")
  console.log("DUMMY CREATED")

  await wait(7000)
  console.log("trigger log id dummy")
  
  Postman.PostMessage({
    address: {
      fm: state.id,
      to: dummy
    },
    type: "LOG",
    payload: null
  })
  console.log("Starting screen capture...")
  
  // Capture and send screen data every ~66ms (15fps)
  const interval = setInterval(() => {
    captureAndSendScreen(dummy);
  }, 66);

  // Stop after 10 seconds for testing
  setTimeout(() => {
    clearInterval(interval);
    console.log("Screen capture stopped");
  }, 10000);
}

new Postman(worker, functions, state);

OnMessage((message) => {
  //console.log("message received:", message)

  Postman.runFunctions(message);
});
