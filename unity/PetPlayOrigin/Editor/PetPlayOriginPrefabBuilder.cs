// Builds the release-grade PetPlay Origin drop-in Modular Avatar prefab under Assets/PetPlay/Origin/.
//
// Canonical source: petplay/unity/PetPlayOrigin/Editor/PetPlayOriginPrefabBuilder.cs
// Batch usage (from a VRChat Avatar SDK3 + Modular Avatar Unity 2022.3 project):
//   Unity -batchmode -quit -projectPath <ProjectPath> \
//     -executeMethod PetPlayOriginPrefabBuilder.RunBatch \
//     -petplayOriginReport <report.json>
//
// Design:
// - Local-only (0 synced Expression Parameter bits, 0 radial menu controls).
// - Always-on when IsLocal == true; Measure subtree is inactive for remote players.
// - Uses native VRC Constraints + Rigidbody/ConfigurableJoint WorldRoot anchor
//   (matching upstream VRLabs CustomObjectSync 1.0.4 commit facc7b5).
// - Overlapping proximity contacts (offset = 2.5 m, radius = 3.0 m, range = ±512 m)
//   with per-axis collision tags so world origin (0,0,0) sits deep inside both receivers
//   (~0.167 proximity) with zero cross-talk and no contact-edge deadzone.
// - Dual PhysBone plane yaw measurement (YawMag + YawSign) decoded continuously via atan2.
// - Optimizer guard: a local-only parameter driver names every output so d4rk Avatar Optimizer
//   does not delete them as unused (PetPlayOriginBuildUtil.AddOutputGuardDriver).
// - Rebuilds update assets in place, keeping their GUIDs.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.Dynamics;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Dynamics.Constraint.Components;
using VRC.SDK3.Dynamics.Contact.Components;
using VRC.SDK3.Dynamics.PhysBone.Components;

public static class PetPlayOriginPrefabBuilder
{
    public const string RootFolder = "Assets/PetPlay/Origin";
    public const string AnimationsFolder = RootFolder + "/Animations";
    public const string WorldPrefabPath = RootFolder + "/World.prefab";
    public const string OriginPrefabPath = RootFolder + "/PetPlayOrigin.prefab";
    public const string ControllerPath = AnimationsFolder + "/PetPlayOrigin.controller";
    public const string LocalOnClipPath = AnimationsFolder + "/PetPlayOriginLocalOn.anim";
    public const string LocalOffClipPath = AnimationsFolder + "/PetPlayOriginLocalOff.anim";
    public const string ReadmePath = RootFolder + "/README.txt";

    // Must match classes/vrcOriginCodec.ts constants.
    public const float RangeMeters = 512f;
    public const float ReceiverOffset = 2.5f;
    public const float ReceiverRadius = 3.0f;
    public const string ParamPrefix = "PetPlay/Origin/";

    static readonly string[] OutputFloatParams =
    {
        ParamPrefix + "PosXPos",
        ParamPrefix + "PosXNeg",
        ParamPrefix + "PosYPos",
        ParamPrefix + "PosYNeg",
        ParamPrefix + "PosZPos",
        ParamPrefix + "PosZNeg",
        ParamPrefix + "YawMag_Angle",
        ParamPrefix + "YawSign_Angle",
    };

    [Serializable]
    class BuildReport
    {
        public bool ok;
        public string error = "";
        public string prefabPath = OriginPrefabPath;
        public float rangeMeters = RangeMeters;
        public float receiverOffset = ReceiverOffset;
        public float receiverRadius = ReceiverRadius;
        public int syncedParameterBits;
        public int localParameterCount;
        public int contactSenders;
        public int contactReceivers;
        public int physBones;
        public int physBoneColliders;
        public int vrcConstraints;
        public List<string> createdAssets = new List<string>();
        public List<string> checks = new List<string>();
    }

    public static void RunBatch()
    {
        var args = Environment.GetCommandLineArgs();
        string reportPath = ArgAfter(args, "-petplayOriginReport") ?? "Library/PetPlayOrigin/report.json";
        var report = new BuildReport();
        int code = 1;
        try
        {
            BuildAndVerify(report);
            report.ok = true;
            code = 0;
        }
        catch (Exception e)
        {
            report.error = e.ToString();
            Debug.LogError("[PetPlayOrigin] " + e);
        }

        string fullReportPath = Path.GetFullPath(reportPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullReportPath));
        File.WriteAllText(fullReportPath, JsonUtility.ToJson(report, true));
        EditorApplication.Exit(code);
    }

    [MenuItem("Tools/PetPlay/Build Origin Prefab")]
    public static void BuildFromMenu()
    {
        var report = new BuildReport();
        BuildAndVerify(report);
        Debug.Log("[PetPlayOrigin] Built and verified: " + JsonUtility.ToJson(report, true));
    }

    static string ArgAfter(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    static void EnsureFolder(string path)
    {
        if (AssetDatabase.IsValidFolder(path)) return;
        string parent = Path.GetDirectoryName(path).Replace('\\', '/');
        EnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
    }

    static void BuildAndVerify(BuildReport report)
    {
        EnsureFolder(RootFolder);
        EnsureFolder(AnimationsFolder);

        // 1. World.prefab: unparented origin transform at (0,0,0) identity.
        //    Referencing this prefab asset in VRCParentConstraint / VRCScaleConstraint anchors
        //    WorldRoot to absolute world origin (0,0,0) in VRChat.
        GameObject worldPrefab = CreateWorldPrefab();
        report.createdAssets.Add(WorldPrefabPath);

        // 2. FX AnimatorController + clips (local-only activation of WorldRoot/Measure).
        AnimatorController controller = CreateAnimatorController();
        report.createdAssets.Add(LocalOnClipPath);
        report.createdAssets.Add(LocalOffClipPath);
        report.createdAssets.Add(ControllerPath);

        // 3. PetPlayOrigin.prefab (drag-and-drop Modular Avatar prefab).
        GameObject originPrefab = CreateOriginPrefab(worldPrefab, controller);
        report.createdAssets.Add(OriginPrefabPath);

        // 4. Short in-Unity README.txt.
        File.WriteAllText(ReadmePath,
            "PetPlay VRC Origin Sync (Modular Avatar Prefab)\n" +
            "===============================================\n\n" +
            "Install:\n" +
            "  1. Make sure Modular Avatar is installed in your VRChat avatar project.\n" +
            "  2. Drag PetPlayOrigin.prefab directly onto your Avatar root (the GameObject\n" +
            "     with VRCAvatarDescriptor) at local position (0,0,0), rotation (0,0,0), scale (1,1,1).\n" +
            "  3. Build and upload your avatar as usual.\n\n" +
            "Details:\n" +
            "  - 0 synced Expression Parameter bits (all parameters are local-only OSC floats).\n" +
            "  - Always-on locally when wearing the avatar; disabled for remote players.\n" +
            "  - Range: +-512 m per axis, continuous 360 deg yaw.\n" +
            "  - Emits /avatar/parameters/PetPlay/Origin/{Pos{X,Y,Z}{Pos,Neg},YawMag_Angle,YawSign_Angle}.\n");
        AssetDatabase.ImportAsset(ReadmePath);
        report.createdAssets.Add(ReadmePath);

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        VerifyPrefab(originPrefab, worldPrefab, report);
    }

    static GameObject CreateWorldPrefab()
    {
        var worldGo = new GameObject("World");
        worldGo.transform.position = Vector3.zero;
        worldGo.transform.rotation = Quaternion.identity;
        worldGo.transform.localScale = Vector3.one;
        try
        {
            var prefab = PrefabUtility.SaveAsPrefabAsset(worldGo, WorldPrefabPath);
            if (prefab == null) throw new Exception($"Failed to save {WorldPrefabPath}");
            return prefab;
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(worldGo);
        }
    }

    static AnimatorController CreateAnimatorController()
    {
        // Assets are updated in place (not deleted and recreated) so their GUIDs, and the
        // references avatars already hold to them, survive a rebuild.
        var onClip = PetPlayOriginBuildUtil.CreateOrClearClip(LocalOnClipPath, "PetPlayOriginLocalOn");
        onClip.SetCurve("WorldRoot/Measure", typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0f, 1f / 60f, 1f));
        EditorUtility.SetDirty(onClip);

        var offClip = PetPlayOriginBuildUtil.CreateOrClearClip(LocalOffClipPath, "PetPlayOriginLocalOff");
        offClip.SetCurve("WorldRoot/Measure", typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0f, 1f / 60f, 0f));
        EditorUtility.SetDirty(offClip);

        var controller = PetPlayOriginBuildUtil.CreateOrClearController(ControllerPath);
        controller.AddParameter("IsLocal", AnimatorControllerParameterType.Bool);
        foreach (string p in OutputFloatParams)
        {
            controller.AddParameter(p, AnimatorControllerParameterType.Float);
        }

        controller.AddLayer("PetPlay Origin Local");
        var layers = controller.layers;
        layers[0].defaultWeight = 1f;
        var sm = layers[0].stateMachine;

        var remoteState = sm.AddState("Remote");
        remoteState.motion = offClip;
        remoteState.writeDefaultValues = false;

        var localState = sm.AddState("Local");
        localState.motion = onClip;
        localState.writeDefaultValues = false;

        sm.defaultState = remoteState;
        PetPlayOriginBuildUtil.AddOutputGuardDriver(remoteState, OutputFloatParams);

        var toLocal = remoteState.AddTransition(localState);
        toLocal.hasExitTime = false;
        toLocal.duration = 0f;
        toLocal.AddCondition(AnimatorConditionMode.If, 0f, "IsLocal");

        var toRemote = localState.AddTransition(remoteState);
        toRemote.hasExitTime = false;
        toRemote.duration = 0f;
        toRemote.AddCondition(AnimatorConditionMode.IfNot, 0f, "IsLocal");

        controller.layers = layers;
        EditorUtility.SetDirty(controller);
        return controller;
    }

    static GameObject CreateOriginPrefab(GameObject worldPrefab, AnimatorController controller)
    {
        var root = new GameObject("PetPlayOrigin");
        try
        {
            // Modular Avatar: non-destructively merge FX layer (Relative paths, match avatar WD).
            var mergeAnimator = root.AddComponent<ModularAvatarMergeAnimator>();
            mergeAnimator.animator = controller;
            mergeAnimator.layerType = VRCAvatarDescriptor.AnimLayerType.FX;
            mergeAnimator.pathMode = MergeAnimatorPathMode.Relative;
            mergeAnimator.matchAvatarWriteDefaults = true;
            mergeAnimator.deleteAttachedAnimator = true;

            // Modular Avatar: register all 8 output floats as local-only (0 synced bits) so VRChat
            // always exposes and streams them over OSC.
            var maParams = root.AddComponent<ModularAvatarParameters>();
            maParams.parameters = new List<ParameterConfig>();
            foreach (string p in OutputFloatParams)
            {
                maParams.parameters.Add(new ParameterConfig
                {
                    nameOrPrefix = p,
                    remapTo = "",
                    internalParameter = false,
                    isPrefix = false,
                    syncType = ParameterSyncType.Float,
                    localOnly = true,
                    defaultValue = 0f,
                    saved = false,
                    hasExplicitDefaultValue = false,
                });
            }

            // Anchor stays parented to PetPlayOrigin (which sits at the avatar root).
            var anchor = new GameObject("Anchor");
            anchor.transform.SetParent(root.transform, false);

            // WorldRoot stays anchored to absolute world origin (0,0,0), identity rotation, scale 1.
            // Keeps Rigidbody + ConfigurableJoint alongside VRCParentConstraint + VRCScaleConstraint
            // per upstream VRLabs CustomObjectSync 1.0.4 (commit facc7b5).
            var worldRoot = new GameObject("WorldRoot");
            worldRoot.transform.SetParent(root.transform, false);

            var rb = worldRoot.AddComponent<Rigidbody>();
            rb.mass = 1f;
            rb.drag = float.PositiveInfinity;
            rb.angularDrag = float.PositiveInfinity;
            rb.useGravity = false;
            rb.isKinematic = false;
            rb.interpolation = RigidbodyInterpolation.Extrapolate;

            var joint = worldRoot.AddComponent<ConfigurableJoint>();
            joint.connectedBody = null;
            joint.anchor = Vector3.zero;
            joint.axis = Vector3.zero;
            joint.secondaryAxis = Vector3.zero;
            joint.autoConfigureConnectedAnchor = false;
            joint.connectedAnchor = Vector3.zero;
            joint.xMotion = ConfigurableJointMotion.Locked;
            joint.yMotion = ConfigurableJointMotion.Locked;
            joint.zMotion = ConfigurableJointMotion.Locked;
            joint.angularXMotion = ConfigurableJointMotion.Locked;
            joint.angularYMotion = ConfigurableJointMotion.Locked;
            joint.angularZMotion = ConfigurableJointMotion.Locked;
            joint.configuredInWorldSpace = false;
            joint.enableCollision = false;

            var worldParentConstraint = worldRoot.AddComponent<VRCParentConstraint>();
            worldParentConstraint.Sources.Add(new VRCConstraintSource(worldPrefab.transform, 1f, Vector3.zero, Vector3.zero));
            worldParentConstraint.Locked = true;
            worldParentConstraint.IsActive = true;

            var worldScaleConstraint = worldRoot.AddComponent<VRCScaleConstraint>();
            worldScaleConstraint.Sources.Add(new VRCConstraintSource(worldPrefab.transform, 1f, Vector3.zero, Vector3.zero));
            worldScaleConstraint.Locked = true;
            worldScaleConstraint.IsActive = true;

            // Measure subtree: inactive by default, enabled only when IsLocal == true.
            var measure = new GameObject("Measure");
            measure.transform.SetParent(worldRoot.transform, false);
            measure.SetActive(false);

            // --- Position measurement (overlapping proximity contacts with per-axis tags) ---
            var posGroup = new GameObject("Position");
            posGroup.transform.SetParent(measure.transform, false);

            float anchorWeight = ReceiverOffset / RangeMeters;
            float originWeight = 1f - anchorWeight;

            BuildPositionAxis(posGroup.transform, anchor.transform, "X", Vector3.right,
                true, false, false, originWeight, anchorWeight);
            BuildPositionAxis(posGroup.transform, anchor.transform, "Y", Vector3.up,
                false, true, false, originWeight, anchorWeight);
            BuildPositionAxis(posGroup.transform, anchor.transform, "Z", Vector3.forward,
                false, false, true, originWeight, anchorWeight);

            // --- Rotation measurement (Yaw only: 1 plane collider + 2 PhysBones) ---
            var rotGroup = new GameObject("Rotation");
            rotGroup.transform.SetParent(measure.transform, false);

            var yawPlaneGo = new GameObject("YawPlane");
            yawPlaneGo.transform.SetParent(rotGroup.transform, false);
            var yawPlaneCollider = yawPlaneGo.AddComponent<VRCPhysBoneCollider>();
            yawPlaneCollider.shapeType = VRCPhysBoneColliderBase.ShapeType.Plane;
            yawPlaneCollider.position = new Vector3(0f, 0f, 10000f);
            yawPlaneCollider.rotation = Quaternion.Euler(90f, 0f, 0f);

            var yawPlaneConstraint = yawPlaneGo.AddComponent<VRCRotationConstraint>();
            yawPlaneConstraint.Sources.Add(new VRCConstraintSource(anchor.transform, 1f, Vector3.zero, Vector3.zero));
            yawPlaneConstraint.AffectsRotationX = false;
            yawPlaneConstraint.AffectsRotationY = true;
            yawPlaneConstraint.AffectsRotationZ = false;
            yawPlaneConstraint.Locked = true;
            yawPlaneConstraint.IsActive = true;

            BuildYawPhysBone(rotGroup.transform, "YawMag", new Vector3(0f, 0f, 1f), yawPlaneCollider, ParamPrefix + "YawMag");
            BuildYawPhysBone(rotGroup.transform, "YawSign", new Vector3(1f, 0f, 0f), yawPlaneCollider, ParamPrefix + "YawSign");

            var prefab = PrefabUtility.SaveAsPrefabAsset(root, OriginPrefabPath);
            if (prefab == null) throw new Exception($"Failed to save {OriginPrefabPath}");
            return prefab;
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(root);
        }
    }

    static void BuildPositionAxis(
        Transform posGroup,
        Transform anchor,
        string axisName,
        Vector3 axisDir,
        bool affectX,
        bool affectY,
        bool affectZ,
        float originWeight,
        float anchorWeight)
    {
        string tag = $"{ParamPrefix}Pos{axisName}";

        var senderGo = new GameObject($"Sender{axisName}");
        senderGo.transform.SetParent(posGroup, false);
        var sender = senderGo.AddComponent<VRCContactSender>();
        sender.shapeType = ContactBase.ShapeType.Sphere;
        sender.radius = 0f;
        sender.collisionTags = new List<string> { tag };

        var posConstraint = senderGo.AddComponent<VRCPositionConstraint>();
        posConstraint.Sources.Add(new VRCConstraintSource(posGroup, originWeight, Vector3.zero, Vector3.zero));
        posConstraint.Sources.Add(new VRCConstraintSource(anchor, anchorWeight, Vector3.zero, Vector3.zero));
        posConstraint.PositionAtRest = Vector3.zero;
        posConstraint.PositionOffset = Vector3.zero;
        posConstraint.AffectsPositionX = affectX;
        posConstraint.AffectsPositionY = affectY;
        posConstraint.AffectsPositionZ = affectZ;
        posConstraint.Locked = true;
        posConstraint.IsActive = true;

        BuildReceiver(posGroup, $"Receiver{axisName}Pos", axisDir * ReceiverOffset, tag, $"{ParamPrefix}Pos{axisName}Pos");
        BuildReceiver(posGroup, $"Receiver{axisName}Neg", -axisDir * ReceiverOffset, tag, $"{ParamPrefix}Pos{axisName}Neg");
    }

    static void BuildReceiver(Transform parent, string name, Vector3 localPos, string tag, string paramName)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = localPos;
        var receiver = go.AddComponent<VRCContactReceiver>();
        receiver.shapeType = ContactBase.ShapeType.Sphere;
        receiver.radius = ReceiverRadius;
        receiver.receiverType = ContactReceiver.ReceiverType.Proximity;
        receiver.collisionTags = new List<string> { tag };
        receiver.allowSelf = true;
        receiver.allowOthers = false;
        receiver.localOnly = true;
        receiver.parameter = paramName;
    }

    static void BuildYawPhysBone(
        Transform parent,
        string name,
        Vector3 endpoint,
        VRCPhysBoneCollider planeCollider,
        string paramName)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        var pb = go.AddComponent<VRCPhysBone>();
        pb.integrationType = VRCPhysBoneBase.IntegrationType.Advanced;
        pb.endpointPosition = endpoint;
        pb.pull = 0f;
        pb.spring = 0f;
        pb.stiffness = 0f;
        pb.gravity = 0f;
        pb.immobile = 1f;
        pb.allowCollision = VRCPhysBoneBase.AdvancedBool.False;
        pb.radius = 0f;
        pb.colliders = new List<VRCPhysBoneColliderBase> { planeCollider };
        pb.allowGrabbing = VRCPhysBoneBase.AdvancedBool.False;
        pb.allowPosing = VRCPhysBoneBase.AdvancedBool.False;
        pb.isAnimated = false;
        pb.resetWhenDisabled = false;
        pb.parameter = paramName;
    }

    static void VerifyPrefab(GameObject originPrefab, GameObject worldPrefab, BuildReport report)
    {
        // Reload from disk to ensure serialized state is clean.
        var loaded = AssetDatabase.LoadAssetAtPath<GameObject>(OriginPrefabPath);
        if (loaded == null) throw new Exception("Failed to reload PetPlayOrigin.prefab");

        var merge = loaded.GetComponent<ModularAvatarMergeAnimator>();
        if (merge == null || merge.animator == null) throw new Exception("Missing ModularAvatarMergeAnimator or controller");
        if (merge.layerType != VRCAvatarDescriptor.AnimLayerType.FX) throw new Exception("MergeAnimator must target FX");
        if (merge.pathMode != MergeAnimatorPathMode.Relative) throw new Exception("MergeAnimator must use Relative path mode");
        if (!merge.matchAvatarWriteDefaults) throw new Exception("MergeAnimator must match avatar Write Defaults");
        report.checks.Add("ModularAvatarMergeAnimator: FX, Relative, matchAvatarWriteDefaults=true");

        PetPlayOriginBuildUtil.VerifyOutputGuardDriver((AnimatorController)merge.animator, OutputFloatParams);
        report.checks.Add("Optimizer guard: local-only driver names every output (d4rk keeps them)");

        var maParams = loaded.GetComponent<ModularAvatarParameters>();
        if (maParams == null || maParams.parameters.Count != OutputFloatParams.Length)
        {
            throw new Exception($"Expected {OutputFloatParams.Length} MA parameters, found {maParams?.parameters.Count ?? 0}");
        }
        foreach (var p in maParams.parameters)
        {
            if (!p.localOnly || p.saved || p.syncType != ParameterSyncType.Float)
            {
                throw new Exception($"Parameter {p.nameOrPrefix} must be localOnly Float, unsaved");
            }
        }
        report.syncedParameterBits = 0;
        report.localParameterCount = maParams.parameters.Count;
        report.checks.Add($"ModularAvatarParameters: {maParams.parameters.Count} local-only floats, 0 synced bits");

        var measure = loaded.transform.Find("WorldRoot/Measure");
        if (measure == null || measure.gameObject.activeSelf)
        {
            throw new Exception("WorldRoot/Measure must exist and start inactive");
        }
        report.checks.Add("WorldRoot/Measure starts inactive (zero remote cost)");

        var worldRoot = loaded.transform.Find("WorldRoot");
        var worldParent = worldRoot.GetComponent<VRCParentConstraint>();
        if (worldParent == null || worldParent.Sources.Count != 1 || worldParent.Sources[0].SourceTransform != worldPrefab.transform)
        {
            throw new Exception("WorldRoot VRCParentConstraint must reference World.prefab");
        }
        if (worldRoot.GetComponent<Rigidbody>() == null || worldRoot.GetComponent<ConfigurableJoint>() == null)
        {
            throw new Exception("WorldRoot must retain Rigidbody + ConfigurableJoint (VRLabs facc7b5)");
        }
        report.checks.Add("WorldRoot anchored via World.prefab VRCParentConstraint/VRCScaleConstraint + Rigidbody/ConfigurableJoint");

        report.contactSenders = loaded.GetComponentsInChildren<VRCContactSender>(true).Length;
        report.contactReceivers = loaded.GetComponentsInChildren<VRCContactReceiver>(true).Length;
        report.physBones = loaded.GetComponentsInChildren<VRCPhysBone>(true).Length;
        report.physBoneColliders = loaded.GetComponentsInChildren<VRCPhysBoneCollider>(true).Length;
        report.vrcConstraints = loaded.GetComponentsInChildren<VRCConstraintBase>(true).Length;

        if (report.contactSenders != 3) throw new Exception($"Expected 3 ContactSenders, got {report.contactSenders}");
        if (report.contactReceivers != 6) throw new Exception($"Expected 6 ContactReceivers, got {report.contactReceivers}");
        if (report.physBones != 2) throw new Exception($"Expected 2 PhysBones, got {report.physBones}");
        if (report.physBoneColliders != 1) throw new Exception($"Expected 1 PhysBoneCollider, got {report.physBoneColliders}");
        if (report.vrcConstraints != 6) throw new Exception($"Expected 6 VRCConstraints, got {report.vrcConstraints}");

        foreach (var r in loaded.GetComponentsInChildren<VRCContactReceiver>(true))
        {
            if (!r.localOnly || !r.allowSelf || r.allowOthers)
            {
                throw new Exception($"Receiver {r.name} must have localOnly=true, allowSelf=true, allowOthers=false");
            }
            if (Mathf.Abs(r.radius - ReceiverRadius) > 1e-4f)
            {
                throw new Exception($"Receiver {r.name} radius mismatch: {r.radius}");
            }
        }
        report.checks.Add("All 6 ContactReceivers verified (localOnly, self-only, radius=3.0, offset=±2.5)");

        // Verify prefab instantiates cleanly under a dummy avatar in an empty scene (not saved).
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var dummyAvatar = new GameObject("DummyAvatar");
        dummyAvatar.AddComponent<VRCAvatarDescriptor>();
        var instance = (GameObject)PrefabUtility.InstantiatePrefab(loaded, dummyAvatar.transform);
        if (instance == null) throw new Exception("Failed to instantiate PetPlayOrigin.prefab on dummy avatar");
        report.checks.Add("Instantiated cleanly under dummy VRCAvatarDescriptor");
    }
}
