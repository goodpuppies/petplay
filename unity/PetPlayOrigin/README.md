# PetPlay VRC Origin Sync

Drop-in Modular Avatar prefabs that expose your VRChat avatar's world-space position and yaw to
PetPlay over local OSC, enabling shared VRChat world coordinates between PetPlay peers.

There are two rigs. Put **one** of them on an avatar:

| | v2 `V2/PetPlayOriginV2.prefab` (preferred) | v1 `PetPlayOrigin.prefab` |
|---|---|---|
| Needs | VRChat Avatar SDK 3.10+ | SDK 3.7+ |
| Position | 1 receiver, `SenderLocalPosition` × 2^N, float32 precision | 6 overlapping proximity contacts |
| Range | 8192 m (N = 13) | ±512 m per axis, coarser past ±102.4 m |
| Yaw | forward sender, `atan2` | 2 PhysBones + plane collider |
| Cost | 2 senders, 2 receivers, 4 constraints | 3 senders, 6 receivers, 2 PhysBones, 6 constraints |

## Installing on any avatar

1. Ensure [Modular Avatar](https://modular-avatar.nadena.dev/) is installed in your VRChat avatar
   project (Unity 2022.3).
2. Import `PetPlay-VRCOrigin.unitypackage` (from PetPlay's GitHub Release assets, or built locally
   with `deno task build:unity-origin`). It contains both rigs.
3. Drag `Assets/PetPlay/Origin/V2/PetPlayOriginV2.prefab` (or the v1
   `Assets/PetPlay/Origin/PetPlayOrigin.prefab`) onto your avatar root (the GameObject with
   `VRCAvatarDescriptor`) at local position `(0, 0, 0)`, rotation `(0, 0, 0)`, scale `(1, 1, 1)`.
4. Build and upload your avatar as usual.

## Shared design

- **0 synced Expression Parameter bits**: every output is registered via
  `ModularAvatarParameters` as a `localOnly` float (`networkSynced = false`, `saved = false`),
  so VRChat streams it over local OSC at 32-bit float precision without touching the avatar's
  256-bit network parameter budget.
- **No radial menu toggle**: always active locally (`IsLocal == true`) and disabled for remote
  players (`WorldRoot/Measure` starts inactive).
- **World-origin anchor**: `WorldRoot` uses native `VRCParentConstraint` + `VRCScaleConstraint`
  referencing the uninstantiated `World.prefab`, retaining `Rigidbody` + `ConfigurableJoint` per
  upstream VRLabs CustomObjectSync 1.0.4 (`facc7b5`).
- **Tracked point**: the avatar root (`Anchor`, a child of the prefab root).
- **Optimizer-safe**: the outputs are written only by contacts / PhysBones and read only over
  OSC, so no animator reads them. d4rk Avatar Optimizer's *Delete Unused Animator Parameters*
  (on by default) would delete such parameters from the FX controller. Each rig's Remote state
  carries a local-only `VRCAvatarParameterDriver` that names every output, which counts as a use.
  AAO *Trace and Optimize* keeps them because they are expression parameters, and VRCFury's
  parameter compressor only touches synced parameters.

## v2 mechanism

- `Sender` sits at `anchor × 2^-N`: its position constraint blends `Anchor` (weight `2^-N`) with
  the world-origin `Measure` (weight `1 − 2^-N`). Both weights and their sum are exact in float32
  and the origin contributes exactly 0, so the scaled position keeps the full precision of the
  world coordinate. A Y-only rotation constraint copies the anchor's yaw.
- `SenderFwd` is `Sender`'s child at local `(0, 0, 2^(3-N))`, 8 m in world terms, so a decode
  that pairs `Pos` and `Fwd` from different frames skews the heading by only
  ~(metres moved per frame) / 8 m.
- Two receivers at world origin (radius 1 m, `Constant`, self-only, local-only) each see one
  sender by collision tag and output its position in receiver space (VRChat SDK 3.10 contact
  advanced parameter `SenderLocalPosition`). The 1 m radius keeps every value inside `[-1, 1]`.
- Decode (`classes/vrcOriginCodec.ts`, `decodePetPlayOriginV2Pose`): `position = Pos × 2^N`,
  `yaw = atan2(dx, dz)` of `Fwd − Pos`. `|Fwd − Pos| = 2^(3-N)`, so the decoder reads N from the
  rig and a rebuild with another `ScaleExponent` needs no decoder change.

### v2 parameters emitted over OSC

- `/avatar/parameters/PetPlay/OriginV2/Pos`, `Fwd` (1 while the sender is inside its receiver)
- `/avatar/parameters/PetPlay/OriginV2/Pos_SenderLocalPosition{X,Y,Z}`
- `/avatar/parameters/PetPlay/OriginV2/Fwd_SenderLocalPosition{X,Y,Z}`

## v1 mechanism

- **Overlapping proximity contacts (±512 m per axis)**:
  - Each axis uses its own collision tag (`PetPlay/Origin/Pos{X,Y,Z}`) to eliminate cross-talk.
  - `Receiver{X,Y,Z}{Pos,Neg}` sit at `±2.5 m` with `radius = 3.0 m` (`localOnly = true`).
  - Within `±102.4 m` of world origin, both `+` and `-` receivers stay strictly positive
    (`pos + neg = 1/3`), avoiding VRChat's proximity-zero edge glitch without any origin offset.
- **Continuous 360° yaw**: 1 plane `VRCPhysBoneCollider` (`YawPlane`) + 2 `VRCPhysBone`s
  (`YawMag`, `YawSign`), decoded via `atan2(cos(π * YawSign_Angle), cos(π * YawMag_Angle))`.

### v1 parameters emitted over OSC

- `/avatar/parameters/PetPlay/Origin/PosXPos`, `PosXNeg`
- `/avatar/parameters/PetPlay/Origin/PosYPos`, `PosYNeg`
- `/avatar/parameters/PetPlay/Origin/PosZPos`, `PosZNeg`
- `/avatar/parameters/PetPlay/Origin/YawMag_Angle`, `YawSign_Angle`

PetPlay (`petplay/VRCOrigin.ts` and `petplay/VRCOriginCamera.ts`) prefers `PetPlay/OriginV2/*`,
then `PetPlay/Origin/*`, and falls back to legacy `CustomObjectSync/*` avatars automatically.

## Rebuilding the prefab assets

`Editor/` holds the canonical generators (excluded from the shipped `.unitypackage`):
`PetPlayOriginPrefabBuilder.cs` (v1), `PetPlayOriginV2PrefabBuilder.cs` (v2) and
`PetPlayOriginBuildUtil.cs`. Copy them into `Assets/PetPlay/Origin/Editor/` of a Unity 2022.3
project with VRChat Avatar SDK 3.10+ and Modular Avatar, run them in batch mode (desktop session:
`DISPLAY` and `XAUTHORITY` set), then copy the generated assets (with `.meta` files) back here and
run `deno task build:unity-origin`:

```
Unity -batchmode -force-vulkan -projectPath <project> \
  -executeMethod PetPlayOriginV2PrefabBuilder.RunBatch -petplayOriginReport <report.json>
```

The builders update existing assets in place, so asset GUIDs (and avatars that already reference
the prefabs) survive a rebuild.
