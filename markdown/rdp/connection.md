# How one RDP tab connects

Status: plan (2026-11-20). One tab for now.

## Pieces

```mermaid
flowchart LR
  Site["static site<br/>page, bundles, iroh wasm"] -. "load code" .-> BP

  subgraph Browser["Browser tab"]
    BP["PostalService"]
    Client["client actor<br/>scene replica + renderer"]
    BP --- Client
  end

  Topic[("topic.petplay.fi<br/>relays records, keeps nothing")]
  Relay(["iroh relay"])

  subgraph Desktop["Desktop process"]
    SP["PostalService<br/>one iroh node"]
    RDP["rdp"]
    UI["UI actor<br/>headless uikit 'browser tab'"]
    Source["desktopSource"]
    Input["desktopInput"]
    SP --- RDP
    SP --- UI
    SP --- Source
    SP --- Input
  end

  BP <-. "records" .-> Topic
  SP <-. "records" .-> Topic
  BP <-- "actor messages over iroh<br/>(browser: always via relay)" --> Relay
  Relay <--> SP
  Client <== "negotiated WebSocket transport<br/>scene deltas, events" ==> UI
  Client -. "WebTransport video" .-> Source
  UI -- "pointer / keys" --> Input
```

## Sequence

```mermaid
sequenceDiagram
  autonumber
  participant C as client actor (browser)
  participant T as topic server
  participant U as UI actor (desktop)

  U->>T: join hash(secret) {actorId, iroh {id, relay}}
  Note over C: page opens later
  C->>T: join hash(secret) {actorId, iroh {id, relay}}
  T-->>U: client's record
  U->>C: dial iroh, send own record (TOPICRECORD)
  Note over C,U: both are contacts now; messages route over iroh
  C->>U: Transport.open(U, purpose "rdp.ui", params {secret})
  U-->>C: answer: websocket, UI actor listens
  C->>U: WebSocket connect (direct over the tailnet)
  C->>U: viewport, DOM events
  U-->>C: scene deltas (latest since ack)
```

The topic server only ever sees `{actorId, iroh id, relay}`. Everything else, including the
WebSocket descriptor and its token, travels over the iroh connection, which is end-to-end
encrypted.

## Access

The link's fragment is a random session secret, never sent to the page's host. The topic is a
hash of it, because the public topic server relays topic names in the clear. Anyone can still
dial the UI actor's process once they see the hash; the UI actor closes any `rdp.ui` transport
whose offer lacks the secret, and the offer travels only over the encrypted iroh connection.

## Open

- **`wss`.** WebTransport needs an https page, and an https page cannot open `ws://`. The
  WebSocket kind needs a certificate (`tailscale cert` for the machine's `*.ts.net` name).
