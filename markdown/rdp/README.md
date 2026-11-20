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
3. **Topics make the first, dumb connection; transports are negotiated over it.** The topic
   server (`submodules/petplayserver`) is public and stays a dumb relay so it can be replaced by a
   DHT. A topic record only says how to reach an actor at all. Anything better (WebSocket,
   WebTransport, Unix sockets, shared memory) is negotiated afterwards, as actor messages over
   that first connection, never advertised on the topic server. See [Topics](#topics).
4. **Iroh is the bootstrap route, including in browsers.** Iroh connections are end-to-end
   encrypted and authenticated by node id, so a node id is safe to publish and is all a topic
   record needs. The usual sequence is: connect over iroh (through a relay if need be) → negotiate
   a WebSocket or other transport over it → optionally move the actor route onto the new transport
   and close the iroh connection.

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

- **Negotiation needs an existing connection.** `Transport.open` runs over an actor route that
  already exists (a local Worker, an IPC child, or a remote proxy from a topic). It never
  discovers peers itself; that is what topics are for.
- **Routes move by moving hub-to-hub links.** Remote routes belong to a `PostalService`, not
  to an actor, so the thing that switches carriers is a link between two hubs (see phase 1b).
- **The actor route can be replaced by a negotiated transport.** Stageforge's existing
  `registerProxyTransport` / `connectProxy` turns a channel into a message route for a remote
  actor. Once a WebSocket is up, the route moves onto it and the iroh connection can be closed (or
  kept as a fallback). Messages in flight during the switch must not be lost or reordered: the
  old route is drained before it is closed.
- **Descriptors carry secrets, so they only travel over the encrypted route.** A WebSocket
  descriptor is `{url, token}`. The token is single-use and binds the new socket to the peer that
  negotiated it, so the WebSocket inherits the iroh connection's peer identity instead of trusting
  whoever connects to the URL.

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

The format stays transport-neutral so the server can be swapped for a DHT. In practice only routes
that are safe to publish go in: iroh node ids. WebSocket URLs and tokens never do.

**Deployed 2026-11-20:** `wss://topic.petplay.fi` runs `submodules/petplayserver` on cachyos under
ldeploy (`~/git/deno-ldeploy/ldeploy.local.jsonc`, app `petplay-topic`, polls `main` every 2 min),
through the `ldeploy` cloudflared tunnel. PetPlay's `--stageforge-networking` uses it by default
(`PETPLAY_TOPIC_URL` overrides). Anyone can connect and every message reaches every client, so a
record reveals the actor ids and routes it carries.

## Browser path

The browser page is the scene-stream viewer, extended into a stageforge peer:

1. Load from the gateway over the tailnet (`tailscale serve` for HTTPS).
2. Reach the `rdp` actor over iroh, by node id from a topic or from the page URL.
3. Negotiate a WebSocket to the gateway over iroh and move the actor route onto it.
4. Negotiate the scene-stream channel (store deltas, pose and view messages, pointer input) and
   media (WebTransport to `petplay-media`, which needs a direct UDP bind on the Tailscale IP since
   `tailscale serve` only proxies TCP).
5. Render the `rdpApp` UI and its video surface; pointer events go back through the scene, where
   the app turns hits on the video surface into `desktopInput` messages.

### Iroh in the browser

Iroh builds for browsers as WebAssembly, but **relay-only**: a browser can't send UDP, so there is
no hole punching and every packet goes through a relay. That is acceptable for a bootstrap route
and is the reason to move onto a direct WebSocket afterwards. There is no general-purpose
browser JavaScript API; iroh's guidance is a small application-specific Rust crate that wraps the
endpoint with `wasm-bindgen` (connect, accept, bidirectional streams). Sources:
[iroh wasm/browser docs](https://docs.iroh.computer/deployment/wasm-browser-support),
[iroh 0.33 release notes](https://iroh.computer/blog/iroh-0-33-0-browsers-and-discovery-and-0-RTT-oh-my).

**Our own crate, not iroh-ffi.** `submodules/irohworker` uses `npm:@number0/iroh` 0.35, the
NAPI bindings, which are too limited (the reason `petplay_mediatransport` already uses iroh from
Rust through `moq-tokio`). On 2026-11-20 the npm package was at 1.2.0 and the `iroh` crate at
1.5.0, so the bindings also trail the crate, and they don't cover browsers at all. Decision: one
PetPlay iroh crate that owns the endpoint, a versioned ALPN for actor routes, message framing and
the transport-negotiation helpers, with two front ends:

- **browser:** `wasm-bindgen` (relay-only, as above);
- **native:** the same crate inside the existing `petplay-media` process, extended to accept actor
  routes next to MoQ media on one endpoint. One node id per machine then covers both, multiplexed
  by ALPN, and a native crash stays outside the PetPlay host process. Deno reaches it over a local
  socket, as `remoteMediaOverlay` already does. In-process `Deno.dlopen` is the alternative if the
  socket hop shows up in latency.

Framing and batching happen in Rust, so JavaScript never handles individual packets.

Relays: public n0 relays work for development. A self-hosted `iroh-relay` could later sit next to
the topic server.

## Open questions

- **Where `rdpApp` runs.** Mounted as a component in the webxr scene (one stream, works now, but
  the app's code runs inside webxr), or its own worker producing its own scene stream that hosts
  embed as a subtree (one writer per stream, as the scene-stream plan requires; app isolation; the
  raylib renderer must consume more than one stream).
- **Keyboard from the browser.** Scene-stream has pointer input only; text needs key events with
  focus held by the app.
- **Audio** exists nowhere in the stack.

## Phases

1. Transport API in stageforge with `messageport` and `websocket` kinds, plus tests: negotiation
   over an existing route, single-use tokens, and moving an actor route onto a new transport
   without losing or reordering messages.
   **1a done 2026-11-20** (`submodules/stageforge/src/lib/Transport.ts`, `transports/`,
   `test/transport.test.ts`): `Transport.open` / `accept`, offer → answer → optional connect
   messages, locality-based kind choice (thread↔thread picks `messageport`, thread↔process
   falls back to `websocket`), single-use WebSocket tokens, close propagation with reasons,
   channels closed on actor shutdown. A worker's transferred MessagePorts now survive the hub
   relay (`shared.ts` keeps them in the message's `transfer` field).
   **1b done 2026-11-20** (`submodules/stageforge/src/lib/Link.ts`, `test/link*.test.ts`): routes
   live in hubs, so a route moves by moving a **hub-to-hub link**. `postal.link(carrier)` links
   two PostalServices (each now has an id, `postal@…`); `link.attach(actor)` routes a remote
   actor; `link.upgrade()` negotiates a new carrier with the transport API run as the hub and
   switches with per-side `switch` markers, holding new-carrier frames until the old carrier is
   left. Tested across processes under load with a slowed bootstrap carrier (in order, nothing
   lost, frames really held) and with in-memory carriers for the orderings timing can't force;
   20/20 repeated runs after fixing a race where the leader's marker beat the follower's
   adoption. Not yet: reconnecting a link whose only carrier dropped.
2. Transport-neutral topic records; iroh as a registered kind; only node ids published.
   **Done 2026-11-20**, built on links rather than per-actor proxies: a record is
   `{type, topic, actorId, hub, routes}`; a hub hearing a join links to the joining hub through a
   registered `LinkCarrierKind` (only `publishable` kinds are put in records), attaches the
   actor, and swaps the topic's members with that hub over the link (`TOPICINTRO`). Duplicate
   links from simultaneous dials resolve to the one dialed by the smaller hub id; routes on the
   dropped link move over. Tested across processes with a stand-in relay and a test-only
   WebSocket carrier, in both join orders, including leave. The old iroh coupling is gone:
   `getIrohAddr`, `ADDREMOTE`/`ADDCONTACTNODE`, `debugMode`, and PetPlay wrapping every actor in
   `IrohWebWorker` under `--stageforge-networking`. Until 2b provides an iroh carrier, networked
   PetPlay publishes records with no routes, so other hubs see them but cannot reach it.
2b. Iroh in the browser: a wasm wrapper crate on the same iroh version as the Deno side.
3. `desktopSource` and `desktopInput` split out of `displayOverlayHost`; the overlay host consumes them.
4. `gateway` actor absorbing `sceneStreamServer` and `desktopRemoteServer`; the browser page as a peer.
5. `rdp` + `rdpApp`: browser-only remote desktop over the tailnet, then the same app in VR.
