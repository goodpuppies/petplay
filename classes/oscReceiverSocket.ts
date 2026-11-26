/**
 * Keep the conventional OSC output port when free; OSCQuery advertises the actual port.
 *
 * Bind `127.0.0.1` explicitly (matching OSCQuery `OSC_IP: "127.0.0.1"`): on Windows, binding
 * `0.0.0.0:9001` succeeds even when another OSC app already holds `127.0.0.1:9001`, and Windows
 * then delivers all `127.0.0.1:9001` datagrams exclusively to the other app.
 */
export function listenOscReceiver(preferredPort: number): Deno.DatagramConn {
  const hostname = "127.0.0.1";
  try {
    return Deno.listenDatagram({ hostname, port: preferredPort, transport: "udp" });
  } catch (error) {
    if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    // Face/eye tracking software commonly owns 9001. Do not share its socket or stop it.
    // Prefer a repeatable port so a receiver restart does not invalidate clients' caches.
    for (let port = preferredPort + 1; port <= Math.min(preferredPort + 10, 65535); port++) {
      try {
        return Deno.listenDatagram({ hostname, port, transport: "udp" });
      } catch (nextError) {
        if (!(nextError instanceof Deno.errors.AddrInUse)) throw nextError;
      }
    }
    return Deno.listenDatagram({ hostname, port: 0, transport: "udp" });
  }
}
