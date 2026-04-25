const US: Record<string, { u: string; s: string }> = {
  "29": { u: "`", s: "~" },
  "02": { u: "1", s: "!" },
  "03": { u: "2", s: "@" },
  "04": { u: "3", s: "#" },
  "05": { u: "4", s: "$" },
  "06": { u: "5", s: "%" },
  "07": { u: "6", s: "^" },
  "08": { u: "7", s: "&" },
  "09": { u: "8", s: "*" },
  "0A": { u: "9", s: "(" },
  "0B": { u: "0", s: ")" },
  "0C": { u: "-", s: "_" },
  "0D": { u: "=", s: "+" },
  "0E": { u: "⌫", s: "⌫" },
  "0F": { u: "Tab", s: "Tab" },
  "10": { u: "q", s: "Q" },
  "11": { u: "w", s: "W" },
  "12": { u: "e", s: "E" },
  "13": { u: "r", s: "R" },
  "14": { u: "t", s: "T" },
  "15": { u: "y", s: "Y" },
  "16": { u: "u", s: "U" },
  "17": { u: "i", s: "I" },
  "18": { u: "o", s: "O" },
  "19": { u: "p", s: "P" },
  "1A": { u: "[", s: "{" },
  "1B": { u: "]", s: "}" },
  "2B": { u: "\\", s: "|" },
  "3A": { u: "Caps", s: "Caps" },
  "1E": { u: "a", s: "A" },
  "1F": { u: "s", s: "S" },
  "20": { u: "d", s: "D" },
  "21": { u: "f", s: "F" },
  "22": { u: "g", s: "G" },
  "23": { u: "h", s: "H" },
  "24": { u: "j", s: "J" },
  "25": { u: "k", s: "K" },
  "26": { u: "l", s: "L" },
  "27": { u: ";", s: ":" },
  "28": { u: "'", s: '"' },
  "1C": { u: "↵", s: "↵" },
  "2A": { u: "Shift", s: "Shift" },
  "2C": { u: "z", s: "Z" },
  "2D": { u: "x", s: "X" },
  "2E": { u: "c", s: "C" },
  "2F": { u: "v", s: "V" },
  "30": { u: "b", s: "B" },
  "31": { u: "n", s: "N" },
  "32": { u: "m", s: "M" },
  "33": { u: ",", s: "<" },
  "34": { u: ".", s: ">" },
  "35": { u: "/", s: "?" },
  "36": { u: "Shift", s: "Shift" },
  "1D": { u: "Ctrl", s: "Ctrl" },
  "E01D": { u: "Ctrl", s: "Ctrl" },
  "38": { u: "Alt", s: "Alt" },
  "E038": { u: "Alt", s: "Alt" },
  "39": { u: "Space", s: "Space" },
  "E05B": { u: "Win", s: "Win" },
  "E05C": { u: "Win", s: "Win" },
  "E05D": { u: "☰", s: "☰" },
  "E052": { u: "Ins", s: "Ins" },
  "E053": { u: "Del", s: "Del" },
  "E047": { u: "Home", s: "Home" },
  "E04F": { u: "End", s: "End" },
  "E049": { u: "PgUp", s: "PgUp" },
  "E051": { u: "PgDn", s: "PgDn" },
  "E048": { u: "↑", s: "↑" },
  "E04B": { u: "←", s: "←" },
  "E050": { u: "↓", s: "↓" },
  "E04D": { u: "→", s: "→" },
  "E11D": { u: "Pause", s: "Pause" },
  "46": { u: "ScLk", s: "ScLk" },
  "54": { u: "Prt", s: "Prt" },
  "3B": { u: "F1", s: "F1" },
  "3C": { u: "F2", s: "F2" },
  "3D": { u: "F3", s: "F3" },
  "3E": { u: "F4", s: "F4" },
  "3F": { u: "F5", s: "F5" },
  "40": { u: "F6", s: "F6" },
  "41": { u: "F7", s: "F7" },
  "42": { u: "F8", s: "F8" },
  "43": { u: "F9", s: "F9" },
  "44": { u: "F10", s: "F10" },
  "57": { u: "F11", s: "F11" },
  "58": { u: "F12", s: "F12" },
  "01": { u: "Esc", s: "Esc" },
  "7D": { u: "⌫", s: "⌫" },
};

function isLetterScancode(n: number): boolean {
  return (n >= 0x10 && n <= 0x19) || (n >= 0x1E && n <= 0x27) || (n >= 0x2C && n <= 0x32);
}

/**
 * @param cap — caps lock (affects letter row keys when `respectCapsLock`)
 * @param shift — either shift
 */
export function usQwertyFromScan(
  codeHex: string,
  { shift, caps }: { shift: boolean; caps: boolean },
  respectCapsLock: boolean,
): { main: string; shiftLabel: string } {
  const k = codeHex.toUpperCase();
  const row = US[k];
  if (row) {
    const n = parseInt(k, 16);
    if (respectCapsLock && isLetterScancode(n)) {
      const upper = shift !== caps;
      return { main: upper ? row.s : row.u, shiftLabel: row.s };
    }
    return { main: shift ? row.s : row.u, shiftLabel: row.s };
  }
  return { main: "·", shiftLabel: "·" };
}

export function scanCodeHexToNumber(hex: string): number {
  return parseInt(hex.replace(/^0x/i, ""), 16);
}
