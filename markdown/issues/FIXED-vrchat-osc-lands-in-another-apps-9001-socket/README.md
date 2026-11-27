# VRChat's OSC goes to another app when PetPlay shares UDP 9001 with it

Status: fixed 2026-11-26 (`7ad3f87` binds `127.0.0.1`; `classes/oscQuery/vrchatLink.ts` replaces the
driver)

## What happens

On Windows, with another program holding `127.0.0.1:9001` (an OSC router, a face-tracking app),
PetPlay never receives a single OSC packet. VRChat finds PetPlay over OSCQuery, reads its HOST_INFO
(the OSC tab says CONNECTED, because it counts OSCQuery requests), and sends to `127.0.0.1:9001`.
The other program gets every datagram. Restarting VRChat or toggling OSC changes nothing, because
PetPlay comes back on the same port each time.

## Why

Before `7ad3f87`, `listenOscReceiver` bound `0.0.0.0:9001` and moved to 9002 only on `AddrInUse`.
Windows lets a `0.0.0.0` socket share a port with another socket's specific `127.0.0.1` bind without
any error, and delivers datagrams addressed to `127.0.0.1` to the specific one. So the fallback
never ran. Checked on the affected PC, with the other program on `127.0.0.1:9001`:

```
bind 0.0.0.0:9001   -> succeeds
bind 127.0.0.1:9001 -> fails: AddressAlreadyInUse
```

The PetPlay log shows the OSCQuery server coming back on `127.0.0.1:33776` (the "port 9001" variant)
eight times in one session. VRChat's log shows it finding `PetPlayCameraOrigin-9001-…` twice, then
`PetPlayCameraOrigin-9002-…` after a hot reload. The old driver still held 9001 for a moment, so the
new one fell over to 9002, and only then did data arrive (about 450 origin parameters a second).

Two smaller things made it hard to see:

- The mDNS side only multicast an announcement every 5 s. It never answered queries and never sent a
  goodbye, so every restart left a dead `PetPlayCameraOrigin-…` record that VRChat kept polling
  (`Could not make new OscClient: An error occurred while sending the request` every 10 s in
  VRChat's log).
- One interface failing `joinMulticastV4` rejected `Promise.all` and took the whole driver down.

## Fix

`7ad3f87` fixed the collision itself: `listenOscReceiver` binds `127.0.0.1`, so `AddrInUse` fires
and the 9002 fallback runs, and the announcer uses `Promise.allSettled`. The driver still preferred
a fixed port, announced without answering queries, never said goodbye, and counted OSCQuery requests
as "connected".

`classes/oscQuery/vrchatLink.ts` replaces it and connects the way OscGoesPurrr and VRCFaceTracking
do:

- waits for VRChat's `_oscjson._tcp` record on mDNS before binding or advertising anything;
- binds UDP and HTTP on `127.0.0.1` with OS-picked ports, so no other program can shadow them;
- advertises `_oscjson._tcp` + `_osc._udp` under a per-launch name (`PetPlay-AB12CD`);
- reads VRChat's OSC port from its `?HOST_INFO` and sends a handshake ping;
- health-checks VRChat's OSCQuery server (two misses disconnect), handles VRChat's mDNS goodbye, and
  ignores a crashed VRChat's leftover record unless ours stops answering;
- watches packets, not requests: 15 s of silence is logged, at 45 s the ping is re-sent, at 75 s the
  advertisement is re-published under a fresh name (retried every 5 min while silent).

`classes/oscQuery/mdns.ts` is a small responder and browser: it answers queries, announces three
times, says goodbye on stop, and skips an interface that fails. The OSC tab now says CONNECTED only
while packets arrive, and Re-announce re-publishes under a fresh name.

## Repro

1. Hold `127.0.0.1:9001` with any UDP socket (e.g. an OSC router), on Windows.
2. Start PetPlay and VRChat with OSC on.
3. Before the fix: `GETCUSTOMOBJECTSYNCCOORDINATE` on `cameraOrigin` stays empty. After: the link
   binds `127.0.0.1:<random>` and parameters arrive.

`deno test -A classes/oscQuery` runs the whole handshake over real mDNS against an in-process fake
VRChat (skipped on CI).
