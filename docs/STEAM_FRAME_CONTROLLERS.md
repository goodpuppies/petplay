# Steam Frame controller bindings

PetPlay ships a native `frame_controller` binding in `resources/bindings_frame_controller.json`,
selected by `resources/actions.json`. Controller selection follows SteamVR's device type, not
the HMD name, so the same bindings apply when Frame controllers are used with another headset.

The mapping targets PetPlay's existing actions:

| Control | Action |
| --- | --- |
| Trigger click, either hand | Select / left click |
| Grip click, either hand | Grab / squeeze |
| Thumbstick, either hand | Existing scroll and push/pull interaction |
| Touch left D-pad down or right A | Right-click modifier |
| Touch left D-pad up or right B | Middle-click modifier |
| Raw tracked pose, either hand | Hand pose |
| Haptic output, either hand | Existing haptic feedback |

Other face buttons, bumpers and menu/system buttons are not assigned new PetPlay behavior.
Skeletal/finger tracking is not consumed by the current action manifest.

## Sources and validation

Valve's [Steam Frame Input documentation](https://partner.steamgames.com/doc/steamhardware/steamframe/input)
specifies the OpenVR controller type and per-hand input paths. OpenVR uses `/input/grip`, while
the OpenXR profile calls the corresponding input `squeeze`; these names must not be mixed.
The left controller has D-pad buttons, while ABXY are all on the right. The modifier choices
above are PetPlay's mappings, not Valve defaults.

Paths were also checked against the genuine recovery image's
`/opt/steamvr/drivers/frame_controller/resources/input/frame_controller_profile.json`
(SteamVR 2.17.10; SHA-256
`0cbb52f75d041a1e1d5a642f1d56373170c54b0862bd1391ce16aa49b0859be6`).
No Valve profile or driver is redistributed here.

`classes/actionBindings.test.ts` checks handed input paths, action references, required pose/
haptic mappings, and staging every manifest binding beside runtime action manifests, including
when an older binding is already staged. The binding is source/profile validated; physical
Steam Frame controller verification remains pending.

## DroidFrame is a separate profile

The `droidframe_quest` engineering binding uses different component names and analog thresholds.
The user confirmed that trigger clicks and grabs work with that binding on 2026-10-16. This
confirms the Quest bridge workaround, not native Frame controller support. Accurate emulation
of the Frame profile is tracked in the DroidFrame repository's
`droidframe/issues/steam-frame-controller-fidelity.md`.

## Blocking game input while using displays

Display frames request a SteamVR input override for the hand pointing at or grabbing them,
including their child controls. The other hand keeps its normal game input. Blocking continues
until held trigger, grip, mouse modifiers and thumbstick are released, so leaving a display
mid-gesture does not pass the held control into the game. Controller unmount and VR teardown
clear the override. `DisplayInstanceFrame` has a `blockGameInput` prop (default `true`).

Enable **Experimental overlay input overrides** in SteamVR's developer settings for this to
work. PetPlay does not change that runtime setting. This uses OpenVR's
[global action-set priority](https://github.com/ValveSoftware/openvr/blob/master/headers/openvr.h)
(`0x01000000`) separately for each hand. SteamVR suppresses sources bound to PetPlay's actions,
including trigger, grip, thumbstick and mouse modifiers; unbound buttons remain available to
the game. This is SteamVR action routing, not OS keyboard/mouse suppression. Hover is taken from
the latest scene pointer intersection, so a newly entered display takes effect on the next
input sample. Live game/controller verification is still required.
