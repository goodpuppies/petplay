/**
 * Detect this machine's Tailscale IPv4 address: asks `tailscale ip -4` first, then falls back
 * to scanning `Deno.networkInterfaces()` for an address in Tailscale's 100.64.0.0/10 CGNAT range.
 */

function isTailnetIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export async function tailnetAddress(): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("tailscale", {
      args: ["ip", "-4"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (success) {
      const ip = new TextDecoder().decode(stdout).trim().split("\n")[0]?.trim();
      if (ip) return ip;
    }
  } catch {
    // tailscale CLI not on PATH; fall back to interface scan.
  }
  try {
    const candidates = Deno.networkInterfaces().filter(
      (iface) => iface.family === "IPv4" && isTailnetIpv4(iface.address),
    );
    const preferred = candidates.find((iface) => /tailscale/i.test(iface.name));
    return (preferred ?? candidates[0])?.address ?? null;
  } catch {
    return null;
  }
}
