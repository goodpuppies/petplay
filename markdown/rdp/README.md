# RDP: a remote desktop composed from actors

A remote desktop from this machine to a browser on a tailnet URL, built as a composition of
reusable actors instead of the hard-wired paths that exist today. It is the test case for making
multiplexing apps easy to build on PetPlay. Actors live in `rdp/`.

## Decisions

1. **Server-rendered UI.** The app's UI is uikit, written 2D-first, running on the server. Browsers
   receive it through the scene stream (`markdown/scene-stream/README.md`, P3–P5) and send pointer
   input back; the same UI appears in VR as a panel in 3D space. The browser holds no UI code.
2. **Actors negotiate their own transports.** Ordinary actor messages (through `PostalService`) are
   the control and signaling channel. Bulk or latency-sensitive data moves over a transport the two
   actors establish between themselves, chosen from a modular registry. See [Transports](#transports).
3. **Discovery goes through topics, independent of iroh.** The topic server
   (`submodules/petplayserver`) stays a dumb relay so it can be replaced by a DHT. A topic record
   carries transport-neutral routes. See [Topics](#topics).

## Composition

```
rdp                    composer: one per shared desktop; owns the lifecycle below
├─ desktopSource       capture → H.264 (screen-streamer + petplay-media); offers a media transport
├─ desktopInput        pointer/keyboard injection (uinput on Linux, SendInput on Windows)
├─ rdpApp              uikit app: video surface + toolbar; pointer on the video → desktopInput
└─ gateway             the HTTPS/WS entry for browsers: page, actor route, scene stream, media info
```

None of these needs OpenVR. `displayOverlayHost` becomes one more consumer of `desktopSource` and
`desktopInput` instead of their owner.

### What each one replaces

| Actor | Today | Change |
| --- | --- | --- |
| `desktopSource` | `ScreenCapturer` + capture helper inside `displayOverlayHost` (needs a live OpenVR runtime); `classes/sceneStreamMedia.ts` supervises `petplay-media --persist` inside the webxr worker | one actor owning capture + encoder with the existing restart policy; consumers ask it for a media transport |
| `desktopInput` | `INPUTCONTROL` verbs written to the capture helper's stdin by `displayOverlayHost`; remote feeds are `input: "none"` | one actor accepting typed pointer/key messages; the helper's stdin becomes its private detail |
| `gateway` | `sceneStreamServer` (module in webxr), `desktopRemoteServer` (own port + origin check), media WebTransport bind | one actor owning the listening port and origin policy; other actors register routes on it |
| `rdpApp` | `remoteMediaOverlay` + `STARTREMOTEMEDIA` singleton in `main`; feed discovery by `remoteMedia@` id prefix | a uikit app any scene can mount; feeds found through a topic |

## Transports

Today every actor message goes through `PostalService`, and every other channel is hand-rolled:
the capture frame TCP socket (fixed port 12345), `GpuMediaSocket` (Unix seqpacket with DMA-BUF
fds), the controller `SharedArrayBuffer`, the helper's stdin, three WebSocket servers and the MoQ
WebTransport bind. Each one hard-codes its own setup, addressing and teardown.

The proposal is a small API in stageforge: an actor asks a peer actor for a channel, the two
exchange an offer and answer as ordinary messages, and the chosen transport kind does the rest.

```ts
// initiator
const channel = await Transport.open(peer, {
  purpose: "rdp.input",            // routed to the peer's accept handler
  kinds: ["messageport", "unix-seqpacket", "websocket"],  // preference order
  params: { ordered: true },
});
channel.send(event);               // or channel.readable / channel.writable for byte streams

// responder
Transport.accept("rdp.input", (channel, from) => { channel.onmessage = ... });
```

- **Kinds are modules.** `registerTransportKind(kind, { available(env), listen(params), connect(descriptor) })`.
  `listen` returns a serializable descriptor plus a promise of the channel; `connect` takes the
  descriptor. The framework only carries `{offer, answer, close}` messages; it knows nothing about
  sockets.
- **Negotiation picks by reachability.** The offer lists kinds the initiator can use; the
  responder intersects them with its own and with locality (same process, same host, network,
  browser). Whichever side can listen does: a browser can't, so the server listens.
- **Lifetimes follow actors.** A channel closes when either actor stops, is murdered or reloads;
  `RELOAD` re-runs negotiation instead of migrating sockets.
- **Initial kinds**, each already proven somewhere in the repo:

| Kind | Reach | Carries | Existing precedent |
| --- | --- | --- | --- |
| `messageport` | threads in one process | structured clone + transfer, bypasses the hub | stageforge relays explicit `transfer` lists already |
| `sab-ring` | threads in one process | fixed-size latest-value or ring | `classes/controllerStateSab.ts` |
| `unix-seqpacket` | one host | messages + fds (DMA-BUF) | `classes/gpuMediaSocket.ts` |
| `websocket` | network / browser | text or binary messages | `WebSocketWorker`, scene stream |
| `webtransport` / `moq` | network / browser | media tracks | `petplay_mediatransport` gateway |
| `iroh` | network, NAT traversal | streams | `submodules/irohworker` |

- **The actor route itself is one negotiated transport.** Stageforge's existing
  `registerProxyTransport` / `connectProxy` stays the mechanism that turns a channel into a
  message route for a remote actor. A browser joins by opening one WebSocket to the gateway, which
  becomes its actor route; everything else is negotiated over that.

## Topics

The topic server relays `{type, actorId, topic, nodeId}` and is deliberately minimal. The coupling
to iroh is entirely in stageforge's `PostalService`:

- `TOPICUPDATE` with a signaling client requires `worker.getIrohAddr()` and throws without a node id.
- A heard join builds `new WorkerClass({ nodeId })`, the iroh worker class, labelled `proxyTransport: "iroh"`.
- `ADDCONTACTNODE` / `ADDREMOTE` carry `nodeid`; the local side throws if its own worker is not iroh.
- `debugMode` forces an iroh proxy for local actors.

Change: a record carries `{type, actorId, topic, routes: [{transport, endpoint}]}`. The receiver
takes the first route whose kind it has a proxy transport factory for and calls `connectProxy`.
Iroh becomes one registered factory (`"iroh"` → `{nodeId}`). `ADDCONTACTNODE` carries routes too.
Local topic membership (`ADDCONTACT`) is unchanged.

**Deployed 2026-11-20:** `wss://topic.petplay.fi` runs `submodules/petplayserver` on cachyos under
ldeploy (`~/git/deno-ldeploy/ldeploy.local.jsonc`, app `petplay-topic`, polls `main` every 2 min),
through the `ldeploy` cloudflared tunnel. PetPlay's `--stageforge-networking` uses it by default
(`PETPLAY_TOPIC_URL` overrides). Anyone can connect and every message reaches every client, so a
record reveals the actor ids and routes it carries.

## Browser path

The browser page is the scene-stream viewer, extended into a stageforge peer:

1. Load from the gateway over the tailnet (`tailscale serve` for HTTPS).
2. Open one WebSocket: the page's actor route.
3. Negotiate the scene-stream channel (store deltas, pose and view messages, pointer input) and
   media (WebTransport to `petplay-media`, which needs a direct UDP bind on the Tailscale IP since
   `tailscale serve` only proxies TCP).
4. Render the `rdpApp` UI and its video surface; pointer events go back through the scene, where
   the app turns hits on the video surface into `desktopInput` messages.

## Open questions

- **Where `rdpApp` runs.** Mounted as a component in the webxr scene (one stream, works now, but
  the app's code runs inside webxr), or its own worker producing its own scene stream that hosts
  embed as a subtree (one writer per stream, as the scene-stream plan requires; app isolation; the
  raylib renderer must consume more than one stream).
- **Keyboard from the browser.** Scene-stream has pointer input only; text needs key events with
  focus held by the app.
- **Audio** exists nowhere in the stack.

## Phases

1. Transport API in stageforge with `messageport` and `websocket` kinds, plus tests.
2. Transport-neutral topic records; iroh as a registered kind.
3. `desktopSource` and `desktopInput` split out of `displayOverlayHost`; the overlay host consumes them.
4. `gateway` actor absorbing `sceneStreamServer` and `desktopRemoteServer`; the browser page as a peer.
5. `rdp` + `rdpApp`: browser-only remote desktop over the tailnet, then the same app in VR.
