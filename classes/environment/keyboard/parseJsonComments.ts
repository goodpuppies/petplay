/** Strip `//` line and `/* *\/` block comments for JSONC-style files. */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "" as string;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];

    if (inLineComment) {
      if (c === "\n" || c === "\r") {
        inLineComment = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < input.length) {
        out += input[i + 1]!;
        i += 2;
        continue;
      }
      if (c === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      i += 1;
      continue;
    }

    if ((c === '"' || c === "'") && !inString) {
      inString = true;
      stringQuote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}
