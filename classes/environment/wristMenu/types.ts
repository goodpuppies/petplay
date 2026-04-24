export type WristMenuButtonId = "layers" | "music" | "signal";

export type WristMenuStateSnapshot = {
  layersActive: boolean;
  musicActive: boolean;
  signalActive: boolean;
};
