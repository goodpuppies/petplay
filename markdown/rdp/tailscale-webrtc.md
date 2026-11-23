# Plain-HTTP Tailscale RDP & Generalized StageForge Transports

Status: implemented (2026-11-23). Builds on `README.md`, `connection.md`, and `peers.md`.

## Goal

Support opening PetPlay's RDP app directly at a plain Tailscale URL (`http://<tailscale-ip>:<port>/#<id>.<secret>`) served by PetPlay itself — **without `tailscale serve`**, **without an external HTTPS host**, and **without exposing anything publicly**.

## Why plain HTTP failed previously

In a browser, `http://<tailscale-ip>:<port>/` is not a SecureContext:

1. `crypto.subtle` is `undefined` → `sessionTopic()` in `rdp/classes/session.ts` failed before connecting.
2. `WebTransport` is `undefined` → `rdp.ui` already falls back to `ws://`, so UI deltas & input work on plain HTTP, **but** `MediaFeeds` (`petplay_mediatransport/web/src/receiver.ts`) required both `WebTransport` and `VideoDecoder` (WebCodecs), neither of which exists on plain HTTP.

`RTCPeerConnection`, `<video>` hardware H.264 decoding, `createImageBitmap(video)`, `OffscreenCanvas`, `WebSocket`, and `iroh-web` (WASM + `wss://`) **all work on plain HTTP**.

## Architecture

### 1. Generalized StageForge Transport (`submodules/stageforge/src/lib/Transport.ts`)

Previously `TransportKind` hard-coded a 1-way client/server handshake (`listen()` → single `descriptor` → `connect(descriptor)`). That cannot express 2-way SDP offer/answer, trickle ICE, mid-session renegotiation, or multi-step auth handshakes.

New model: **Selection + a scoped bidirectional signaling channel**.

- **Selection (`TRANSPORTOFFER` → `{ kind, side }`)**: kinds still declare `listenReach`, `connectReach`, `preferListener` so asymmetric kinds (e.g. browser cannot listen on WebSocket/WebTransport) negotiate cleanly regardless of who calls `Transport.open`.
- **Signaling (`TRANSPORTSIGNAL { id, data }`, with optional `transfer`)**: replaces `TRANSPORTCONNECT`.
  - Both sides run one method: `kind.establish(ctx): Promise<KindConnection>`.
  - `ctx` provides `{ id, role: "initiator" | "responder", side: "listener" | "connector", peer, params, signal }`.
  - `signal` (`TransportSignal`) provides `send(data, transfer?)`, `recv(): Promise<unknown>`, `onmessage` (push-based for trickle/ongoing signaling), and `abort: AbortSignal`.
  - Initiator allocates the `id` and registers its signal inbox *before* sending `TRANSPORTOFFER`, so responder signals arriving early are buffered with no race and no extra RTT.
  - `signal` stays alive until `transport.closed` resolves (then cleans up automatically), enabling trickle ICE and track renegotiation.
  - `TRANSPORTCANCEL { id, reason }` aborts the peer's `ctx.signal.abort`.
- **Caller API unchanged**: `Transport.open`, `Transport.accept`, `messages(transport)` stay identical.
- Built-in kinds (`messagePort`, `webSocket`, `webTransport`) migrate to `establish(ctx)`.

### 2. Separate Discovery ID & Auth Secret (`rdp/classes/session.ts`)

Topic names in StageForge are public rendezvous names ("hello, I'm an RDP actor reachable via…"), not a security mechanism; authentication happens after connecting over the encrypted iroh route.

- `newSession()` generates two independent random base64url tokens using `crypto.getRandomValues` (works on plain HTTP):
  - `id`: public session rendezvous ID → topic `rdp-<id>`.
  - `secret`: private auth credential checked on `rdp.ui` over iroh.
- Link format: `<base>#<id>.<secret>` (fragment never leaves the browser).
- Drops `crypto.subtle` / SHA-256 completely from the RDP session path.

### 3. WebRTC H.264 Video in `petplay-media` (`submodules/petplay_mediatransport`)

- Add `str0m` (pure Rust, sans-IO WebRTC: ICE-lite, DTLS-SRTP, H.264 RTP packetization) alongside the existing MoQ/WebTransport publisher in `petplay-media`.
- Feed the existing Annex-B H.264 access units directly into RTP H.264 (no re-encode, shared across all viewers).
- Expose a local SDP offer→answer handshake on the publisher (e.g. a loopback HTTP/JSON or control endpoint bound per feed, or stdin/stdout) so `desktopSource` can broker WebRTC sessions for browsers over StageForge.
- Keep WebTransport + WebCodecs as the default when the browser is in a SecureContext (`https://` or `localhost`); automatically use WebRTC when `WebTransport` or `VideoDecoder` is unavailable (plain HTTP over Tailscale) or requested.

### 4. Browser WebRTC Receiver & StageForge `webrtc` Kind (`rdp/browser/`, `web/scene-stream/`)

- `RTCPeerConnection` and `<video>` exist only on the main thread (`rdp/browser/page.ts`), not inside Web Workers (`rdp/browser/client.ts`).
- `page.ts` owns the WebRTC media receiver (and `<video>` elements), receives frames via `requestVideoFrameCallback` → `createImageBitmap(video)`, and transfers `ImageBitmap`s to the `client.ts` worker over the existing `MessagePort`.
- `SceneView.setFeedFrame` (`web/scene-stream/sceneView.ts`) widens its frame type from `VideoFrame` to `VideoFrame | ImageBitmap` (both upload directly to WebGL2 and have `.close()`).
- Signaling runs through StageForge's `Transport` (`webrtc` kind on `desktopSource` ↔ `client.ts` bridged to `page.ts`).

## Phases

1. **StageForge `Transport.ts` remodel** (done): `establish(ctx)` + `TRANSPORTSIGNAL`, migrated `messagePort`, `webSocket`, `webTransport`, added multi-round-trip & ongoing signaling test (`13 passed`).
2. **RDP session `<id>.<secret>`** (done): dropped `crypto.subtle` in `rdp/classes/session.ts` and updated `rdp.ts`, `ui.tsx`, `page.ts`, `client.ts`.
3. **`petplay-media` WebRTC H.264 publisher (`str0m`)** (done): pure-Rust `str0m` (`rust-crypto`) ICE-lite H.264 RTP publisher in `submodules/petplay_mediatransport/src/webrtc.rs` with loopback `POST /offer` signaling (`WEBRTC_READY`).
4. **`desktopSource` + `rdp/browser` WebRTC video transport** (done): `rdp/classes/webRtcVideoTransport.ts` StageForge `webrtc-video` transport kind, `WEBRTC_OFFER` on `desktopSource` (including `GUARDED` household), main-thread `<video>` → `createImageBitmap` bridge in `page.ts`, widened `SceneView.setFeedFrame` for `VideoFrame | ImageBitmap`, automatic fallback when `WebTransport` or `VideoDecoder` is unavailable (or `?webrtc=1`).
