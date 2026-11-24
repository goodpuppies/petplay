/**
 * Builds the 3D calibration's shader table (`ColorClassifier.shaderTable`, ~130 ms) off the thread
 * that asked for it: the headset render thread (`headsetDepthSource.ts`) can't stall that long.
 */
import { ColorClassifier } from "./colorCalibration.ts";

/** This runs as a worker: its postMessage takes a transfer list (DOM's global types it as a window). */
const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

export type TableRequest = { id: number; samples: Uint8Array; levels: number };
export type TableReply = {
  id: number;
  data: Uint8Array;
  width: number;
  height: number;
  size: number;
  tiles: number;
};

globalThis.onmessage = (event: MessageEvent<TableRequest>) => {
  const { id, samples, levels } = event.data;
  const table = new ColorClassifier(samples, levels).shaderTable(64, 8);
  const reply: TableReply = {
    id,
    data: table.data,
    width: table.width,
    height: table.height,
    size: 64,
    tiles: 8,
  };
  scope.postMessage(reply, [table.data.buffer]);
};
