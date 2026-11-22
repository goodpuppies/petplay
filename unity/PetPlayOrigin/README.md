# PetPlay VRC Origin Sync

Drop-in Modular Avatar prefab that exposes your VRChat avatar's world-space position and yaw to
PetPlay over local OSC, enabling shared VRChat world coordinates between PetPlay peers.

## Installing on any avatar

1. Ensure [Modular Avatar](https://modular-avatar.nadena.dev/) is installed in your VRChat avatar
   project (Unity 2022.3 + VRChat Avatar SDK 3.7+).
2. Import `PetPlay-VRCOrigin.unitypackage` (from PetPlay's GitHub Release assets, or built locally
   with `deno task build:unity-origin`).
3. Drag `Assets/PetPlay/Origin/PetPlayOrigin.prefab` onto your avatar root (the GameObject with
   `VRCAvatarDescriptor`) at local position `(0, 0, 0)`, rotation `(0, 0, 0)`, scale `(1, 1, 1)`.
4. Build and upload your avatar as usual.

## Design

- **0 synced Expression Parameter bits**: all 8 output parameters are registered via
  `ModularAvatarParameters` as `localOnly` floats (`networkSynced = false`, `saved = false`),
  so VRChat streams them over local OSC at 32-bit float precision without touching the avatar's
  256-bit network parameter budget.
- **No radial menu toggle**: always active locally (`IsLocal == true`) and disabled for remote
  players (`WorldRoot/Measure` starts inactive).
- **World-origin anchor**: `WorldRoot` uses native `VRCParentConstraint` + `VRCScaleConstraint`
  referencing `World.prefab`, retaining `Rigidbody` + `ConfigurableJoint` per upstream VRLabs
  CustomObjectSync 1.0.4 (`facc7b5`) for compatibility with current VRChat.
- **Overlapping proximity contacts (±512 m per axis)**:
  - Each axis uses its own collision tag (`PetPlay/Origin/Pos{X,Y,Z}`) to eliminate cross-talk.
  - `Receiver{X,Y,Z}{Pos,Neg}` sit at `±2.5 m` with `radius = 3.0 m` (`localOnly = true`).
  - Within `±102.4 m` of world origin, both `+` and `-` receivers stay strictly positive
    (`pos + neg = 1/3`), avoiding VRChat's proximity-zero edge glitch without any origin offset.
- **Continuous 360° yaw**: 1 plane `VRCPhysBoneCollider` (`YawPlane`) + 2 `VRCPhysBone`s
  (`YawMag`, `YawSign`), decoded via `atan2(cos(π * YawSign_Angle), cos(π * YawMag_Angle))`
  in `classes/vrcOriginCodec.ts`.

## Parameters emitted over OSC

- `/avatar/parameters/PetPlay/Origin/PosXPos`, `PosXNeg`
- `/avatar/parameters/PetPlay/Origin/PosYPos`, `PosYNeg`
- `/avatar/parameters/PetPlay/Origin/PosZPos`, `PosZNeg`
- `/avatar/parameters/PetPlay/Origin/YawMag_Angle`, `YawSign_Angle`

PetPlay (`petplay/VRCOrigin.ts` and `petplay/VRCOriginCamera.ts`) prefers `PetPlay/Origin/*` when
present and falls back to legacy `CustomObjectSync/*` avatars automatically.

## Rebuilding the prefab assets

`Editor/PetPlayOriginPrefabBuilder.cs` is the canonical generator (excluded from the shipped
`.unitypackage`). Run it in batch mode against any Unity 2022.3 project with VRChat Avatar SDK3
and Modular Avatar, then copy the generated `Assets/PetPlay/Origin/` assets (with `.meta` files)
back here and run `deno task build:unity-origin`.
