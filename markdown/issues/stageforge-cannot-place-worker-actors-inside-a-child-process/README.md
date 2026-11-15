# Stageforge cannot place worker actors inside an existing child process

Status: open
Track: stability-performance

## What happens

An actor running in an `IPCWorker` child process cannot ask Stageforge to create a worker-thread
actor **in that same process**. `PostMan.create` sends `CREATE` to the host's `System`; the host
`PostalService` constructs the worker. Selecting a worker backend chooses how to run the actor,
but does not express which existing process should own it.

This matters for the VRChat depth debugger. The desktop renderer must stay isolated from the
headset renderer's global raylib/window/GL state. Capture and decoding belong in a worker beside
the desktop renderer, where they can publish depth through `SharedArrayBuffer`. A worker created
in the host process cannot share that memory with the desktop child process.

## Expected

Support child-local worker actors: a process actor can create a worker actor in its own process,
with normal Stageforge addressing, message routing, health, shutdown and reload behaviour. The
placement should be explicit; existing `PostMan.create` calls must keep their current behaviour.

Shared memory and transferable buffers should stay on the local worker path. Cross-process
messages should retain their ordinary serialization rules and clearly reject unsupported shared
memory instead of silently pretending it can cross the process boundary.

## Repro / code trace

1. Start an actor with `{ worker: "process" }`.
2. From that actor, call `PostMan.create` with the worker-thread backend.
3. The request targets the host `System`, which calls the host `PostalService.add`; the new worker
   belongs to the host process, not the requesting child.

Relevant code, inspected 2026-11-07:

- `submodules/stageforge/src/lib/PostMan.ts:137`: `create` constructs the `CREATE` message to
  `System`; its payload includes a backend but no process placement.
- `submodules/stageforge/src/lib/PostalService.ts:372`: host `CREATE` dispatch.
- `submodules/stageforge/src/lib/PostalService.ts:536`: `add` resolves and constructs the worker
  within that service's process.
- `submodules/stageforge/src/lib/types.ts:116`: `ActorCreateOptions` exposes only `worker`.

This describes the current creation API and process placement, not a claim that a plain Deno
worker cannot be created inside an IPC child.

## Current workaround

`petplay/desktopView.ts:663` creates a plain Deno worker in the desktop process for
`classes/vrchatDepth/captureWorker.ts`. Three shared frame slots provide bounded latest-frame
delivery. The intake actor leases capture ownership so the worker replaces the existing capture
instead of duplicating it, and the standalone intake resumes if the lease expires.

The workaround requires hand-written worker startup, error handling, stop acknowledgement and
capture-ownership cleanup outside Stageforge's actor lifecycle. It should be replaceable by a
child-local Stageforge actor without changing the depth frame format or shared-buffer protocol.

## Acceptance checks

- A process actor can explicitly create an actor worker in its own process; verify the process
  identity differs from the host and matches the requesting child.
- A shared-buffer write in that worker is visible to its parent without JSON/base64 conversion;
  transferable buffers detach and transfer correctly on the local route.
- Both host and child-local actors can address the worker with ordinary actor IDs and receive
  replies; cross-process routes cannot carry `SharedArrayBuffer`.
- Stopping/crashing the parent tears down its local workers and releases their resources. Worker
  failures are visible through Stageforge supervision/health.
- Reload has documented ownership and snapshot rules, including what happens to shared buffers
  and in-flight messages; no orphan workers remain after parent reload.
- Existing host-created thread and process actors continue to work unchanged.
