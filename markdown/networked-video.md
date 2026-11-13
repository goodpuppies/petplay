# Networked video: headset-free display experiment

## Update: userspace headless output works

The subsequent userspace Vulkan display experiment succeeded without another privileged change.
SteamVR selects a layer-owned 1920×1080@75 display, whose surface maps to the installed Mesa
driver's real headless swapchain. The 35-second lab window reached 2,250 logged presents.
A bounded moving red-overlay control showed changing positions in both eyes across image reuse,
then disappearance after the overlay was destroyed. Capture waits on the compositor's actual
render semaphore; the synthetic display clock is a separate pacing mechanism.

Implementation, reproduction, validation and limitations:
[`submodules/petplay_ovrdriver/HEADLESS-DISPLAY.md`](../submodules/petplay_ovrdriver/HEADLESS-DISPLAY.md).
The lab option is `--headless-display`; the marker control is
`utils/petplay-ovrdriver-headless-marker.ts`. Encoding and transport are still unimplemented.
The prior DRM experiment's HDMI-A-1 remains forced off, with its EDID removed; this experiment
does not change that kernel state.

The longer run also clarifies the earlier crash interpretation: this compositor presented for
over 30 seconds, then dumped during the lab's requested shutdown. The master monitor disconnect
and vrserver's quit sequence precede the dump. Shutdown and the startup `bad event=1` warning
remain unresolved, so this is a working rendering proof rather than a production-stability result.

## Earlier DRM connector investigation

Continues the 2026-11-13 work in `submodules/petplay_ovrdriver/PRESENT-BOUNDARY.md`.

## Intended paths

- No physical headset: OpenVR scene → PetPlay native video → moq → browser WebXR or desktop
  controls. The virtual HMD is a production source, with remote tracking eventually driving it.
- Physical headset: normal VR gameplay → PetPlay native video → moq → another PetPlay instance.

Deno orchestrates the pipeline; GPU images, synchronization, encoding and transport should stay
native. Encoding and moq transport are not implemented by this experiment.

## Current evidence

The physical-headset present-boundary proof is committed in driver revision `e1b48b6`. It uses
the compositor's real render wait semaphore and replaces the present wait with its own completion.
It has not yet demonstrated temporal freshness with moving scene content or a sustained encoder.

The driver-direct semaphore experiment proves that a newly allocated, unregistered resource-manager
timeline semaphore does not advance spontaneously. It does **not** prove that every possible
producer-side synchronization or interception mechanism is unavailable. There is still no validated
completion contract for the current driver-direct reader.

The inherited virtual-display patch disabled the debug property but still reported a fictional
desktop display through `IVRDisplayComponent` and registered the old DisplayRedirect sink. The
continuation fixes those contradictions and disables the compositor plugin for DRM-panel mode.
The launcher uses a scoped `redirectsDisplay=false` manifest, leaving the built driver manifest
intact. Default sessions explicitly clear `virtualDisplay` in their scoped settings.

Two unprivileged baseline sessions (12:54 and 12:56 local time) reached:

```
Looking for direct display through RandR
Looking for direct display through Vulkan WSI
CHmdWindowSDL: Failed to create direct mode surface
```

The first searched for the old 1280×720 default. The second correctly searched for 1920×1080
using the new `virtual1080` preset. Neither baseline had a matching connected display; both
restored the original settings and registrations. These runs are not a test of the forced connector.
Logs: `logs/ovrdriver-lab/20261113-125429` and `20261113-125704`.

## Temporary connector experiment

Target only the disconnected, disabled HDMI-A-1 connector on AMD GPU `0000:09:00.0`, currently
`card1`. Do not touch the desktop monitor or the physical headset connector.

The original 128-byte prototype EDID described an ordinary monitor. The revised scratch EDID
adds a DisplayID 2.0 extension with primary use case 7 (head-mounted VR), allowing the kernel to
identify a non-desktop output without pretending to be a known headset vendor. `edid-decode`
reports PPL/product 20560, 1920×1080 at 75 Hz, and correct base, extension and DisplayID checksums.
Whether KDE offers that forced connector for a DRM lease remains untested.

Scratch artifacts:

- `_scratch/petplay-virtual-hmd.edid`: 256-byte prototype; SHA-256
  `5df981fb906a6f84714316cba8f1ce6848a47de878c2b359bd1ae5c7789c1178`.
- `_scratch/virtual-display-window.py`: fixed-target elevated helper. Refuses an active connector,
  existing force/override, wrong GPU, or changed EDID. Applies the override and forces connection
  for 90 seconds; `finally` resets the override and attempts automatic detection. If the kernel
  retains a stale connected state, it leaves this unused connector forced off and warns. SIGKILL or a
  hardware/kernel failure can prevent cleanup. No firmware installation or boot change.

During that window, with SteamVR initially off:

```sh
python3 utils/petplay-ovrdriver-lab.py run \
  --virtual-display 16908:20560 --display-profile virtual1080 \
  --present-audit --present-proof 3 \
  --direct-server --x11-compositor --guard-monitor --seconds 30
```

Success requires a display-surface swapchain with the expected extent, actual presents carrying
render waits, and usable stereo pixels. A connected sysfs node alone is insufficient. If the
display cannot be leased or produces no vblank, record that failure rather than treating EDID
recognition as a working headless compositor.

## Validation

- `zig build test -Doptimize=ReleaseSafe` and `zig build -Doptimize=ReleaseSafe` pass.
- ABI fixture checks DRM-mode display flags, EDID properties, absent DisplayRedirect device,
  and refusal of the legacy compositor plugin. Existing default/direct-mode tests still pass.
- Isolated launcher fixtures verify virtual/default settings, scoped manifest, output geometry,
  and byte-exact settings/registration restoration without launching SteamVR.
- Plain `zig build test` currently fails in the debug executable linker on system CRT `.sframe`
  relocations (`R_X86_64_PC64`); the documented ReleaseSafe configuration succeeds.

The first graphical authorization expired without approval. The user requested a retry and
approved it. At 13:05 local time, the helper successfully forced HDMI-A-1 connected and sysfs
exposed the expected 1920×1080 mode and complete VR EDID. However, `kscreen-doctor -o` still
listed only the existing desktop outputs, and SteamVR's RandR search saw only 3440×1440 and
5088×2544. Both RandR and Vulkan WSI searches failed to find the synthetic panel. SteamVR fell
back to a 1920×1080 platform-window swapchain (`mode=1`, `waits=1`), not a display surface; the
proof directory `logs/ovrdriver-lab/present-audit-lzy3t8lp/frames` remained empty. The lab stopped
and restored its settings and driver registrations normally.

This confirms EDID injection and forced kernel connection, **not** discovery or leasing. The
helper currently reprobes through sysfs but sends no explicit DRM hotplug notification. Missing
notification is a candidate explanation for the desktop compositor not discovering the output;
it has not been tested. Do not rule out the virtual-display approach from this result.

Cleanup caveat: the first helper's `reset`/`detect` completed but left sysfs reporting connected
with the synthetic EDID. Its success exit therefore did not establish full restoration. A follow-up
cleanup request resets the override, cycles off/detect, and leaves the unused connector forced off
if automatic detection still reports the stale connection. The scratch helper now checks this too.
The user approved this cleanup; final verification was `force=off status=disconnected
overrideBytes=0 edidBytes=0`. HDMI-A-1 is left forced off rather than in automatic-detection mode.
Writing `detect` restores automatic detection, but immediately doing so reproduced the stale
connection in this experiment. A fresh hardware hotplug or reboot may be needed to clear the
driver's cached sink; that has not been tested.

The virtual-panel and headless-display work is committed in driver revision `0b7bf97`.
The pre-existing `raythree` change is unrelated and was left outside these commits.
