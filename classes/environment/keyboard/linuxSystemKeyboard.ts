import type { KeyboardLogicEvent, KeyboardSink } from "./types.ts";

const MODIFIER_SCANS: Record<string, string> = {
  shift: "2A",
  leftCtrl: "1D",
  rightCtrl: "E01D",
  leftAlt: "38",
  rightAlt: "E038",
  leftMeta: "E05B",
  rightMeta: "E05C",
};

const VIRTUAL_KEY_SCANS: Record<string, string> = {
  NUMLOCK: "45",
  DIVIDE: "E035",
  MULTIPLY: "37",
  SUBTRACT: "4A",
  NUMPAD7: "47",
  NUMPAD8: "48",
  NUMPAD9: "49",
  ADD: "4E",
  NUMPAD4: "4B",
  NUMPAD5: "4C",
  NUMPAD6: "4D",
  NUMPAD1: "4F",
  NUMPAD2: "50",
  NUMPAD3: "51",
  RETURN: "E01C",
  NUMPAD0: "52",
  DECIMAL: "53",
};

export function createLinuxKeyboardSink(send: (command: string) => void): KeyboardSink {
  return (event: KeyboardLogicEvent) => {
    if (event.kind === "modifier") {
      if (event.modifier === "caps") {
        if (event.active) {
          send("K,3A,1\nK,3A,0");
        }
        return;
      }
      const scan = MODIFIER_SCANS[event.modifier];
      if (scan) send(`K,${scan},${event.active ? 1 : 0}`);
      return;
    }
    const scan = event.scanCodeHex && event.scanCodeHex !== "00"
      ? event.scanCodeHex
      : event.virtualKeyName
      ? VIRTUAL_KEY_SCANS[event.virtualKeyName.toUpperCase()]
      : undefined;
    if (!scan) return;
    if (event.pressed != null) {
      send(`K,${scan},${event.pressed ? 1 : 0}`);
    } else {
      // One actor message and pipe write, with ordered native input transitions.
      send(`K,${scan},1\nK,${scan},0`);
    }
  };
}
