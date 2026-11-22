PetPlay VRC Origin Sync (Modular Avatar Prefab)
===============================================

Install:
  1. Make sure Modular Avatar is installed in your VRChat avatar project.
  2. Drag PetPlayOrigin.prefab directly onto your Avatar root (the GameObject
     with VRCAvatarDescriptor) at local position (0,0,0), rotation (0,0,0), scale (1,1,1).
  3. Build and upload your avatar as usual.

Details:
  - 0 synced Expression Parameter bits (all parameters are local-only OSC floats).
  - Always-on locally when wearing the avatar; disabled for remote players.
  - Range: +-512 m per axis, continuous 360 deg yaw.
  - Emits /avatar/parameters/PetPlay/Origin/{Pos{X,Y,Z}{Pos,Neg},YawMag_Angle,YawSign_Angle}.
