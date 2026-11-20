# markdown/

Working notes for PetPlay: plans, investigations, checklists and the issue tracker. `docs/` is
for settled, user-facing explanation (architecture, setup); `markdown/` is where things are still
being decided or worked on. When a plan lands, its durable parts move into `docs/` and the plan
folder stays as history.

## Layout

- `<topic>.md` — a single-file note.
- `<topic>/README.md` — a multi-file plan; the README is its index and holds the decisions.
- [`issues/`](./issues/README.md) — bug and task tracking without GitHub. One folder per issue.
- [`sec/`](./sec/) — triaged security and dependency alerts, and why each was decided.

## Active

- [What PetPlay is](./what-petplay-is.md): identity, scope, what it is not.
- [PetPlay 2.0](./petplay-2.0/README.md) — product work: from "usable" to "an app people install".
- [Scene stream](./scene-stream/README.md) — the raythree IR as a glTF-aligned, reactive,
  replicated store, streamed to the overlay, desktop views and a browser client. Supersedes
  [retained raythree IR](./raythree-retained-ir/README.md).
- [RDP](./rdp/README.md) — remote desktop to a browser as a composition of actors: transports
  negotiated over actor messages, transport-neutral topics, server-rendered uikit UI.
- [VRChat depth](./vrchat-depth/README.md) — overlays composited with VRChat's depth: an avatar
  shader writes depth into the desktop window, PetPlay decodes it and cuts occlusion holes.
- [What screen-relay offers](./screen-relay-lessons.md) — ideas for remote desktop and web
  streaming from `research/screen-relay`: adaptive bitrate, encode on change, input protocol.
