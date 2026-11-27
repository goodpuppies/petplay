# Steam Link on Linux forces overlays to low resolution and game-cadence jitter when dashboard is closed

Status: open (upstream SteamVR / Steam Link limitation, documented 2026-11-27)
Track: rendering

## What happens

When using **Steam Link on Linux** (SteamVR 2.18.4, `driver_vrlink`, Quest 3), all OpenVR overlays — including PetPlay (both panorama and native overlay mode) as well as other third-party overlays — suffer from two issues while the SteamVR dashboard is closed:

1. **Low resolution:** Overlays look noticeably soft/low-res compared to when the SteamVR dashboard is opened. Native overlay mode brings PetPlay on par with other SteamVR overlays, but cannot exceed Steam Link's in-game overlay sharpness. Opening the SteamVR dashboard immediately makes overlays appear high-resolution.
2. **Cadence jitter:** All overlays jitter with the active VR app's (e.g. VRChat's) frame pacing/reprojection rather than tracking smoothly at the headset's refresh rate.

Neither issue reproduces on **Virtual Desktop (Windows)** or **wired headsets on Linux**.

## Expected

Overlays should render at full clarity and track smoothly at the headset's refresh rate regardless of whether the SteamVR dashboard is open or closed.

## Repro

1. Connect a Quest 3 via Steam Link to SteamVR 2.18.4 on Linux.
2. Launch a VR scene app (e.g. VRChat) and PetPlay (panorama or native overlay mode).
3. Observe overlay sharpness and motion smoothness with the SteamVR dashboard closed vs. opened.

## Notes / evidence

Observed in SteamVR logs (`vrcompositor.txt`, `driver_vrlink.txt`, `vrlink_aftm_*.csv`, `steamvr.vrsettings`) on 2026-11-27:

- **App-pose lock (`vrcompositor.txt`):**
  - `Driver requests system layer use app poses.`
  - `driver_vrlink` forces `vrcompositor` to composite all overlay layers using the active app's pose and submission cadence into a single stereo video frame (so headset-side ATW reprojects the combined frame from one pose). When the VR app fluctuates or reprojects, every overlay inherits that jitter. Opening the dashboard switches off app poses to the compositor's own live HMD pose.
- **Foveated Vulkan Video encode cap (`driver_vrlink.txt`):**
  - Even with `supersampleScale: 1.5` (`2528x2704` per-eye swapchain), `overlayRenderQuality_2: 3`, and `streamFormatWidth: 1344`, Steam Link's Linux Vulkan Video encoder (`[VideoVulkan]`) created a `uWidth: 1088, uHeight: 4352` (4-slice HEVC) encode session.
  - Because Steam Link does not stream OpenVR overlay quads separately, all overlays are composited into that single foveated HEVC stream alongside the active game. Opening the dashboard pauses/dims the game so the encoder devotes its bitrate to the overlays and `vrcompositor` renders overlays directly in the Facet distortion pass (`distort_geom_ps.spv`).
- **Facet compositor cannot be disabled on Linux SteamVR 2.18.4:**
  - Setting `"useFacetRenderer": false` in `steamvr.vrsettings` and restarting SteamVR still logs `[Facet] Creating shader pipeline:` and does not change either symptom.
- **Ruled out network/decode as the sole cause (`vrlink_aftm_*.csv`):**
  - At `targetBandwidth: 350` Mbps (`automaticBandwidth: false`), headset decode took `p50=11.2ms / p95=21.5ms` on a `13.9ms` (72 Hz) budget with `19.4%` dropped vsyncs and `176ms` network spikes, compounding the jitter.
  - Lowering `targetBandwidth` to `60` Mbps brought decode down to `p50=3.9ms / p95=5.1ms` and network to `p50=2.7ms / p95=3.8ms` (`2.9%` drops), yet both the overlay jitter and the dashboard-open resolution jump persisted.

## Workarounds / future directions

- **On Steam Link (partial mitigation):** Keep `targetBandwidth` around `150–200` Mbps (or `automaticBandwidth: true`) and `streamFormatWidth: 1344` to avoid 20+ ms Quest decode stalls while keeping encode sharpness as high as Steam Link allows.
- **Alternative streamers / hardware:** Virtual Desktop (Windows), ALVR (Linux), or wired/DisplayPort headsets (and Steam Frame) do not exhibit this Steam Link Linux limitation.
- **Potential OpenVR experiment:** Testing `IVROverlay::SetHighQualityOverlay(handle)` on the focused/hovered native panel could verify whether SteamVR's single HQ overlay slot improves sharpness while the dashboard is closed (though it cannot bypass `driver_vrlink`'s single-pose app-pose lock).
- **Long-term:** Headset-side quad compositing (streaming PetPlay quads/video directly to an OpenXR client on the headset) decouples PetPlay from both the PCVR video encoder and the game's cadence.
