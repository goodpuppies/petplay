# Desktops on other machines, and sharing between PetPlay users

Status: design, 2026-11-20. Builds on `README.md` and `connection.md`.

Two cases, one mechanism:

1. **Household.** A headless agent on another machine (cachyos, GNOME) offers its desktop. The
   rdp app here, or PetPlay, shows it as one more desktop.
2. **Two PetPlay users.** Two people in VR share desktops with each other, peer to peer, with
   no browser and no server in the media path.

In both cases a desktop is a pair of actors, `desktopSource` and `desktopInput`, found through a
topic and reached over iroh. Only who may find them, and what they may do, differs.

## The agent

`rdp/agent.ts`: like `rdp/main.ts`, but with no UI actor, no site and no link. It runs a
PostalService with the iroh carrier and the topic server, spawns `desktopSource` and
`desktopInput`, and joins the topic derived from its secret. Run it as a user service on the
machine whose desktop it offers. Its consumers (the rdp UI actor, PetPlay) list the topic's
`desktopSource@` contacts as desktops.

## Secrets and access

- **Household:** a gitignored `.secret` file in the repo root, the same on every machine.
  (`.env` is for configuration, not secrets.)
- **Two users:** a password they agree on, for now. Passwords are guessable, and the topic
  name is public on the topic server. So the topic comes from a slow KDF of the password
  (PBKDF2, fixed salt), never a plain hash.
- **Later:** VRChat identity replaces the password. Who you are and whom you're friends with come
  from VRChat. The iroh connection and the proofs below stay as they are.

The topic only gets two processes talking. Access is decided over iroh:

- **Proofs bound to node ids.** Today the tab sends the secret itself in its offer, so anyone
  announcing a fake `rdp-ui@` on the topic would receive it. Instead, each side proves knowledge
  of the secret with `HMAC(secret, purpose ‖ initiator node id ‖ responder node id)`. The secret
  is never sent. A proof can't be replayed to a third party, because it names both ends.
- **Grants, per peer.** Membership lets a peer see that a desktop exists. Watching and
  controlling are separate grants. In the household case both are on by default. Between users,
  each grant is asked for and accepted in VR, shown while active and revocable. Input is never
  granted implicitly.

## Transports

- **Video for a browser:** `webtransport`, as now. The encoder serves WebTransport with a pinned
  certificate on the agent's LAN or tailnet address.
- **Video for PetPlay:** MoQ over iroh. `petplay-media` already publishes this way, and
  `petplay/remoteMediaOverlay.ts` already receives it natively (VA-API → DMA-BUF → overlay).
  What changes is the share code: it travels as a descriptor over the actor route, and the source
  admits only the node id that asked, which the README lists as missing ("restricting a source to
  specific viewer identities").
- **Input:** no transport of its own. In one process the UI actor opens `rdp.input` over
  `messageport`, as now. Across machines it sends `desktopInput` the `INPUT` messages it
  already accepts, which travel over the iroh route like any actor message (NAT included). A
  real iroh transport kind, its own stream on the connection for bulk data, may come later for
  video or for replacing the main path. Input doesn't need it.

## Order

1. `.secret`, the agent, input over the actor route, and node-bound proofs (replacing the plain secret in
   the `rdp.ui` offer). Test as two local processes, then on cachyos.
2. The rdp app lists several desktops: a picker in the toolbar.
3. `desktopSource` offers an iroh feed. PetPlay shows a found desktop through
   `remoteMediaOverlay`, with input through the same `desktopInput`.
4. Two users: a password, the grant prompts in VR, and an active-share indicator.
5. VRChat identity.
