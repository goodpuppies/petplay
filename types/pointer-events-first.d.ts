// The vendored uikit and @pmndrs/pointer-events both augment three's Object3DEventMap with
// different pointer event types; whichever the checker reads first wins. Runtime events come from
// pointer-events, so this file, first in tsconfig.json "files", makes its augmentation win.
import type {} from "@pmndrs/pointer-events";
