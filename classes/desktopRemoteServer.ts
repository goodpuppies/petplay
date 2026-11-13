export type RemotePointerSession = {
  receive(value: unknown): void;
  cancel(): void;
  close?(): void;
};
/** One active browser input session for one Deno-owned rendered viewport. */
export class DesktopRemoteServer {
  private createSession: (() => RemotePointerSession) | null = null;
  private socket: WebSocket | null = null;
  private input: RemotePointerSession | null = null;
  attach(createSession: () => RemotePointerSession): () => void {
    this.createSession = createSession;
    return () => {
      this.disconnect();
      this.createSession = null;
    };
  }
  private disconnect() {
    this.input?.cancel();
    this.input?.close?.();
    this.input = null;
    this.socket?.close(1000, "Viewport closed");
    this.socket = null;
  }
  handle(req: Request, allowedOrigin?: string): Response {
    if (!this.createSession) return new Response("Viewport not ready", { status: 503 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    // This endpoint shares the PetPlay scene's opt-in loopback control server.
    if (req.headers.get("origin") !== (allowedOrigin ?? new URL(req.url).origin)) {
      return new Response("Origin mismatch", { status: 403 });
    }
    if (this.socket) return new Response("A pointer session is already connected", { status: 409 });
    let input: RemotePointerSession;
    try {
      input = this.createSession();
    } catch (error) {
      return new Response(String(error), { status: 503 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 10 });
    this.socket = socket;
    this.input = input;
    const cleanup = () => {
      input.cancel();
      input.close?.();
      if (this.socket === socket) {
        this.socket = null;
        this.input = null;
      }
    };
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 2048) {
          throw Error("Invalid input packet");
        }
        const message = JSON.parse(event.data);
        if (message.type === "cancel") input.cancel();
        else if (message.type !== "heartbeat") input.receive(message);
      } catch (error) {
        socket.close(1008, String(error).slice(0, 100));
        cleanup();
      }
    };
    socket.onclose = cleanup;
    socket.onerror = cleanup;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(
        JSON.stringify({
          version: 1,
          viewport: "steamvr-stereo",
        }),
      );
    };
    return response;
  }
}
