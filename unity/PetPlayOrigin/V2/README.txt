PetPlay VRC Origin v2 (Modular Avatar Prefab)
=============================================

Install:
  1. Needs VRChat Avatar SDK 3.10+ and Modular Avatar.
  2. Drag PetPlayOriginV2.prefab onto your Avatar root (the GameObject with
     VRCAvatarDescriptor) at local position (0,0,0), rotation (0,0,0), scale (1,1,1).
     Use either this or the v1 PetPlayOrigin.prefab, not both.
  3. Build and upload your avatar as usual.

Details:
  - 0 synced Expression Parameter bits (all parameters are local-only OSC floats).
  - Always-on locally when wearing the avatar; disabled for remote players.
  - Range: 8192 m from world origin, continuous 360 deg yaw.
  - Emits /avatar/parameters/PetPlay/OriginV2/{Pos,Fwd}[_SenderLocalPosition{X,Y,Z}].
  - Safe with VRCFury, AAO and d4rk Avatar Optimizer.
