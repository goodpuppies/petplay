/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
import { parseArgs, runProbe } from "./raylib_openvr_overlay.ts";

globalThis.onmessage = (event: MessageEvent) => {
  const data = event.data as { type: string; args: string[] };
  if (data.type !== "start") {
    return;
  }

  try {
    const config = parseArgs(data.args);
    postMessage({
      type: "log",
      message: `starting mode=${config.mode} hidden=${config.hidden} size=${config.width}x${config.height}`,
    });
    runProbe(config);
    postMessage({ type: "done" });
  } catch (error) {
    postMessage({
      type: "error",
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
  }
};
