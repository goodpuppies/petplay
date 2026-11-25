/**
 * Minimal cross-platform clipboard writer (no native FFI required).
 * - Windows: `clip.exe`
 * - Linux: `wl-copy` (when on Wayland), then `xclip -selection clipboard`, then `xsel --clipboard --input`.
 */
async function tryWriteViaCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  try {
    const child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
    const status = await child.status;
    return status.success;
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (Deno.build.os === "windows") {
    return await tryWriteViaCommand("clip.exe", [], text);
  }
  const candidates: Array<[string, string[]]> = [];
  if (Deno.env.get("WAYLAND_DISPLAY")) {
    candidates.push(["wl-copy", []]);
  }
  candidates.push(
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["wl-copy", []],
  );
  for (const [cmd, args] of candidates) {
    if (await tryWriteViaCommand(cmd, args, text)) return true;
  }
  return false;
}
