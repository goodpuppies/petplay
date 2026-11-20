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
- **PostalService stays a background manager.** It creates workers and routes messages; it has
  no identity of its own across processes and negotiates nothing. Remote actors are proxy routes
  over one connection per remote process (see revision below).
- **Later: replacing the main path.** In a browser, iroh always goes through a relay. Moving an
  actor route from iroh onto a negotiated WebSocket (without losing or reordering messages) is
  planned, not built.
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
   **Done 2026-11-20.** Native: `petplay-media link` (`submodules/petplay_mediatransport/src/link.rs`),
   one iroh endpoint per hub, ALPN `petplay/link/1`, driven over stdio by
   `classes/irohLinkCarrier.ts`; registered under `--stageforge-networking`. It publishes
   `{id, relay}`, no IP addresses. Browser: `link-web/` (wasm-bindgen, iroh =1.4.1, relay-only,
   dial-only) with `classes/irohWebLinkCarrier.ts`. A hub that hears a join it cannot dial
   re-announces its members once, so a dial-only page also finds members that joined first.
   Tests (`classes/irohLinkCarrier.test.ts`, `tests/iroh-link/`): native↔native over loopback
   iroh; two hubs meet through a topic, link over iroh and upgrade to a WebSocket; the wasm
   module (run in Deno) reaches a native hub through a local `iroh-relay --dev`, including the
   re-announce path. Also checked once against n0's public relays: wasm→native connect in
   0.8 s (3.3 s for the native endpoint to come online). With the dev relay the first connect
   takes ~10 s, because QUIC address discovery is off there. The live release
   `petplay-media` predates `link`; rebuild with `--features iroh` before using networking.
3. `desktopSource` and `desktopInput` split out of `displayOverlayHost`; the overlay host consumes them.
   **3a done 2026-11-20, additively** (`displayOverlayHost` untouched while it runs live VR):
   - `rdp/desktopInput.ts` runs `screen-streamer --input-only` (new flag: uinput from stdin, no
     capture, no portal). `INPUT`/`INPUTS` messages or a negotiated `rdp.input` channel carry
     `{t: pointer|button|wheel|key}`; pointer coordinates are normalized over the workspace.
     Malformed events are counted and dropped; held buttons and keys are released on
     `RELEASEALL`, when a channel closes and on shutdown.
   - `rdp/desktopSource.ts` runs the encoder (`DesktopMediaFeed`, `petplay-media --persist`) and
     `screen-streamer --no-frame-socket --no-input --media-socket=…` with its own portal restore
     token. `START {host, port}` / `FEED` return `{host, port, fingerprint}` for a WebTransport
     receiver; both processes restart with backoff until `STOP`.
   - Tested with stand-in helpers (nothing injected, no portal) and the real encoder
     (`rdp/rdp.test.ts`). Not yet run against a real capture or real uinput events: both would
     act on the live desktop. Linux only; Windows has the pieces (`SendInput` sinks,
     `petplay-media capture-tcp`) to sit behind the same messages.
   **3b remaining:** coordinate mapping when the capture is one monitor of several, and moving
   `displayOverlayHost` onto these actors.
**Revision 2026-11-20 (afternoon): hub links removed.** Phases 1b and 2 put networking into the
hub (hub ids, links, carrier upgrades, `TOPICINTRO`, hub-level negotiation). That moved too much
onto the main thread, which should only do what has to happen there. Now:
- `Link.ts` is gone; `Remote.ts` has `RemoteConnection`: one connection per remote process,
  carrying ordinary actor messages. Remote actors are proxy routes on it; a message from an
  unknown actor teaches the reply route; a message for a non-local actor is dropped.
- Topics as originally intended: a record is `{type, topic, actorId, routes}`, `routes` holding
  the process's one carrier endpoint (`postal.registerRemoteCarrier`, iroh in PetPlay). A process
  that hears a join dials it and sends its own members' records along (`TOPICRECORD`), since the
  topic server keeps nothing; a 15 s re-announce covers the race where neither side heard.
- The browser is reachable: `link-web` accepts through its relay, so a page publishes
  `{id, relay}` like any process (`classes/irohWebCarrier.ts`; native is `classes/irohCarrier.ts`).
- `Channel` is now `Transport`: `Transport.open(peer, {purpose})` returns one. Only actors
  negotiate; the hub does not.
- Link codec: `Uint8Array` and `ArrayBuffer` survive JSON carriers (base64).
Tests: stageforge `test/topic.test.ts` (both join orders, bytes, the lost-joins race; mutations
of the dial record and of re-announce fail them), PetPlay `tests/iroh-topics/` (native and wasm,
the page dialed through its relay), `rdp/test/`.

**Next:** a transport is just the kind's connection (WebSocket messages, WebTransport streams,
MessagePort), with the stageforge message protocol as an option on top, not built in.

4. `gateway` actor absorbing `sceneStreamServer` and `desktopRemoteServer`; the browser page as a peer.
5. `rdp` + `rdpApp`: browser-only remote desktop over the tailnet, then the same app in VR.
