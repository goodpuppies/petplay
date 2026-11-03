/**
 * The MSDF `Text` from the uikit bridge.
 *
 * This used to remount the bridge `Text` whenever its string changed, because uikit's `Content`
 * kept the bounding box of the first glyph mesh it saw and stretched new text to it. A fresh
 * `Content` wires its child only after a `setTimeout(0)`, though, so every remount drew the label
 * oversized for a frame: a once-a-second readout made the wrist menu flash. The bridge `Text`
 * (`webgpu-uikit.tsx`) now tells its `Content` about every change before the next frame, so text
 * updates in place.
 */
export { Text } from "../../../submodules/threewebxrwebgpudeno/webgpu-uikit.tsx";
