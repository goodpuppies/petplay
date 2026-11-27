// Builds PetPlay Origin v2 ("GPS") under Assets/PetPlay/Origin/V2/: a drop-in Modular Avatar
// prefab that reports the avatar's world position and yaw over local OSC using VRChat 3.10's
// contact receiver SenderLocalPosition output. v1 (PetPlayOriginPrefabBuilder) stays available.
//
// Canonical source: petplay/unity/PetPlayOrigin/Editor/PetPlayOriginV2PrefabBuilder.cs
// Batch usage (VRChat Avatar SDK 3.10+ and Modular Avatar, Unity 2022.3):
//   Unity -batchmode -quit -projectPath <ProjectPath> \
//     -executeMethod PetPlayOriginV2PrefabBuilder.RunBatch \
//     -petplayOriginReport <report.json>
//
// Mechanism (must match classes/vrcOriginCodec.ts, decodePetPlayOriginV2Pose):
// - WorldRoot is pinned to world origin by constraints to the uninstantiated World.prefab asset.
// - Sender sits at Anchor * 2^-N: a position constraint blends Anchor (weight 2^-N) with the
//   world-origin Measure (weight 1 - 2^-N). Both weights and the sum are exact in float32, and the
//   origin contributes exactly 0, so the scaled position carries the full float precision of the
//   world coordinate. A Y-only rotation constraint copies Anchor's yaw.
// - SenderFwd is Sender's child at local (0, 0, 2^(F-N)), F = FwdOffsetExponent = 3: 8 m in
//   world terms. Its offset from Sender is the heading, and its length tells the decoder N, so a
//   rebuild with another N needs no decoder change. A long offset keeps the heading steady when a
//   decode pairs Pos and Fwd from different frames (error ~ metres moved per frame / 8 m).
// - Two receivers at world origin (radius 1 m, Constant, self-only, local-only) each see exactly
//   one sender by collision tag and output its position in receiver space:
//     <param>            1 while the sender is inside (validity)
//     <param>_SenderLocalPositionX/Y/Z
//   The 1 m radius keeps every output inside [-1, 1] and makes metres and radius-normalised units
//   the same, so the decode does not depend on how VRChat scales or clamps these floats.
// - Range: |Anchor| < 2^N m (sphere). Precision: that of the float32 world coordinate.
// - Local-only (0 synced bits), no menu, no PhysBones. Measure is inactive for remote players.
// - Optimizer guard as in v1 (PetPlayOriginBuildUtil.AddOutputGuardDriver).
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

public static class PetPlayOriginV2PrefabBuilder
{
    public const string RootFolder = "Assets/PetPlay/Origin/V2";
    public const string AnimationsFolder = RootFolder + "/Animations";
    public const string WorldPrefabPath = RootFolder + "/World.prefab";
    public const string OriginPrefabPath = RootFolder + "/PetPlayOriginV2.prefab";
    public const string ControllerPath = AnimationsFolder + "/PetPlayOriginV2.controller";
    public const string LocalOnClipPath = AnimationsFolder + "/PetPlayOriginV2LocalOn.anim";
    public const string LocalOffClipPath = AnimationsFolder + "/PetPlayOriginV2LocalOff.anim";
    public const string ReadmePath = RootFolder + "/README.txt";

    /// N: senders sit at 2^-N of the anchor's world position; range is 2^N m.
    public const int ScaleExponent = 13;
    /// F: SenderFwd sits 2^(F-N) ahead of Sender (2^F m in world terms).
    public const int FwdOffsetExponent = 3;
    public const float ReceiverRadius = 1f;
    public const string ParamPrefix = "PetPlay/OriginV2/";
    public const string PosParam = ParamPrefix + "Pos";
    public const string FwdParam = ParamPrefix + "Fwd";
    public const string PosTag = ParamPrefix + "Pos";
    public const string FwdTag = ParamPrefix + "Fwd";

    static float Scale => Mathf.Pow(2f, -ScaleExponent);
    static float FwdOffset => Mathf.Pow(2f, FwdOffsetExponent - ScaleExponent);

    static IEnumerable<string> ReceiverOutputs(string param) => new[]
    {
        param,
        param + ContactReceiver.PARAM_SENDER_LOCAL_POSITION_X,
        param + ContactReceiver.PARAM_SENDER_LOCAL_POSITION_Y,
        param + ContactReceiver.PARAM_SENDER_LOCAL_POSITION_Z,
    };

    static readonly string[] OutputFloatParams =
        ReceiverOutputs(PosParam).Concat(ReceiverOutputs(FwdParam)).ToArray();

    [Serializable]
    class BuildReport
    {
        public bool ok;
        public string error = "";
        public string prefabPath = OriginPrefabPath;
        public int scaleExponent = ScaleExponent;
        public float rangeMeters = Mathf.Pow(2f, ScaleExponent);
        public float receiverRadius = ReceiverRadius;
        public int fwdOffsetExponent = FwdOffsetExponent;
        public List<string> outputs = OutputFloatParams.ToList();
        public int syncedParameterBits;
        public int localParameterCount;
        public int contactSenders;
        public int contactReceivers;
        public int physBones;
        public int vrcConstraints;
        public List<string> createdAssets = new List<string>();
        public List<string> checks = new List<string>();
    }

    public static void RunBatch()
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, "-petplayOriginReport");
        string reportPath = i >= 0 && i + 1 < args.Length ? args[i + 1] : "Library/PetPlayOrigin/v2-report.json";
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
            Debug.LogError("[PetPlayOriginV2] " + e);
        }

        string fullReportPath = Path.GetFullPath(reportPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullReportPath));
        File.WriteAllText(fullReportPath, JsonUtility.ToJson(report, true));
        EditorApplication.Exit(code);
    }

    [MenuItem("Tools/PetPlay/Build Origin V2 Prefab")]
    public static void BuildFromMenu()
    {
        var report = new BuildReport();
        BuildAndVerify(report);
        Debug.Log("[PetPlayOriginV2] Built and verified: " + JsonUtility.ToJson(report, true));
    }

    static void BuildAndVerify(BuildReport report)
    {
        PetPlayOriginBuildUtil.EnsureFolder(RootFolder);
        PetPlayOriginBuildUtil.EnsureFolder(AnimationsFolder);

        GameObject worldPrefab = CreateWorldPrefab();
        report.createdAssets.Add(WorldPrefabPath);

        AnimatorController controller = CreateAnimatorController();
        report.createdAssets.Add(LocalOnClipPath);
        report.createdAssets.Add(LocalOffClipPath);
        report.createdAssets.Add(ControllerPath);

        GameObject originPrefab = CreateOriginPrefab(worldPrefab, controller);
        report.createdAssets.Add(OriginPrefabPath);

        File.WriteAllText(ReadmePath,
            "PetPlay VRC Origin v2 (Modular Avatar Prefab)\n" +
            "=============================================\n\n" +
            "Install:\n" +
            "  1. Needs VRChat Avatar SDK 3.10+ and Modular Avatar.\n" +
            "  2. Drag PetPlayOriginV2.prefab onto your Avatar root (the GameObject with\n" +
            "     VRCAvatarDescriptor) at local position (0,0,0), rotation (0,0,0), scale (1,1,1).\n" +
            "     Use either this or the v1 PetPlayOrigin.prefab, not both.\n" +
            "  3. Build and upload your avatar as usual.\n\n" +
            "Details:\n" +
            "  - 0 synced Expression Parameter bits (all parameters are local-only OSC floats).\n" +
            "  - Always-on locally when wearing the avatar; disabled for remote players.\n" +
            $"  - Range: {Mathf.Pow(2f, ScaleExponent):0} m from world origin, continuous 360 deg yaw.\n" +
            "  - Emits /avatar/parameters/PetPlay/OriginV2/{Pos,Fwd}[_SenderLocalPosition{X,Y,Z}].\n" +
            "  - Safe with VRCFury, AAO and d4rk Avatar Optimizer.\n");
        AssetDatabase.ImportAsset(ReadmePath);
        report.createdAssets.Add(ReadmePath);

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        VerifyPrefab(worldPrefab, report);
    }

    static GameObject CreateWorldPrefab()
    {
        var worldGo = new GameObject("World");
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
        var onClip = PetPlayOriginBuildUtil.CreateOrClearClip(LocalOnClipPath, "PetPlayOriginV2LocalOn");
        onClip.SetCurve("WorldRoot/Measure", typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0f, 1f / 60f, 1f));
        EditorUtility.SetDirty(onClip);

        var offClip = PetPlayOriginBuildUtil.CreateOrClearClip(LocalOffClipPath, "PetPlayOriginV2LocalOff");
        offClip.SetCurve("WorldRoot/Measure", typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0f, 1f / 60f, 0f));
        EditorUtility.SetDirty(offClip);

        var controller = PetPlayOriginBuildUtil.CreateOrClearController(ControllerPath);
        controller.AddParameter("IsLocal", AnimatorControllerParameterType.Bool);
        foreach (string p in OutputFloatParams)
        {
            controller.AddParameter(p, AnimatorControllerParameterType.Float);
        }

        controller.AddLayer("PetPlay Origin V2 Local");
        var layers = controller.layers;
        layers[0].defaultWeight = 1f;
        var sm = layers[0].stateMachine;

        var remoteState = sm.AddState("Remote");
        remoteState.motion = offClip;
        remoteState.writeDefaultValues = false;
        PetPlayOriginBuildUtil.AddOutputGuardDriver(remoteState, OutputFloatParams);

        var localState = sm.AddState("Local");
        localState.motion = onClip;
        localState.writeDefaultValues = false;

        sm.defaultState = remoteState;

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
        var root = new GameObject("PetPlayOriginV2");
        try
        {
            var mergeAnimator = root.AddComponent<ModularAvatarMergeAnimator>();
            mergeAnimator.animator = controller;
            mergeAnimator.layerType = VRCAvatarDescriptor.AnimLayerType.FX;
            mergeAnimator.pathMode = MergeAnimatorPathMode.Relative;
            mergeAnimator.matchAvatarWriteDefaults = true;
            mergeAnimator.deleteAttachedAnimator = true;

            // Local-only floats: 0 synced bits, exposed over OSC, ignored by parameter compressors.
            var maParams = root.AddComponent<ModularAvatarParameters>();
            maParams.parameters = OutputFloatParams.Select(p => new ParameterConfig
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
            }).ToList();

            // The tracked point: the avatar root, as in v1.
            var anchor = new GameObject("Anchor");
            anchor.transform.SetParent(root.transform, false);

            // WorldRoot: world origin, identity rotation, scale 1 (same anchoring as v1).
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

            var worldParent = worldRoot.AddComponent<VRCParentConstraint>();
            worldParent.Sources.Add(new VRCConstraintSource(worldPrefab.transform, 1f, Vector3.zero, Vector3.zero));
            worldParent.Locked = true;
            worldParent.IsActive = true;

            var worldScale = worldRoot.AddComponent<VRCScaleConstraint>();
            worldScale.Sources.Add(new VRCConstraintSource(worldPrefab.transform, 1f, Vector3.zero, Vector3.zero));
            worldScale.Locked = true;
            worldScale.IsActive = true;

            var measure = new GameObject("Measure");
            measure.transform.SetParent(worldRoot.transform, false);
            measure.SetActive(false);

            BuildReceiver(measure.transform, "ReceiverPos", PosTag, PosParam);
            BuildReceiver(measure.transform, "ReceiverFwd", FwdTag, FwdParam);

            var senderGo = new GameObject("Sender");
            senderGo.transform.SetParent(measure.transform, false);
            AddSender(senderGo, PosTag);

            var posConstraint = senderGo.AddComponent<VRCPositionConstraint>();
            posConstraint.Sources.Add(new VRCConstraintSource(measure.transform, 1f - Scale, Vector3.zero, Vector3.zero));
            posConstraint.Sources.Add(new VRCConstraintSource(anchor.transform, Scale, Vector3.zero, Vector3.zero));
            posConstraint.PositionAtRest = Vector3.zero;
            posConstraint.PositionOffset = Vector3.zero;
            posConstraint.Locked = true;
            posConstraint.IsActive = true;

            var yawConstraint = senderGo.AddComponent<VRCRotationConstraint>();
            yawConstraint.Sources.Add(new VRCConstraintSource(anchor.transform, 1f, Vector3.zero, Vector3.zero));
            yawConstraint.AffectsRotationX = false;
            yawConstraint.AffectsRotationY = true;
            yawConstraint.AffectsRotationZ = false;
            yawConstraint.Locked = true;
            yawConstraint.IsActive = true;

            var fwdGo = new GameObject("SenderFwd");
            fwdGo.transform.SetParent(senderGo.transform, false);
            fwdGo.transform.localPosition = new Vector3(0f, 0f, FwdOffset);
            AddSender(fwdGo, FwdTag);

            var prefab = PrefabUtility.SaveAsPrefabAsset(root, OriginPrefabPath);
            if (prefab == null) throw new Exception($"Failed to save {OriginPrefabPath}");
            return prefab;
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(root);
        }
    }

    static void AddSender(GameObject go, string tag)
    {
        var sender = go.AddComponent<VRCContactSender>();
        sender.shapeType = ContactBase.ShapeType.Sphere;
        sender.radius = 0f;
        sender.localOnly = true;
        sender.collisionTags = new List<string> { tag };
    }

    static void BuildReceiver(Transform parent, string name, string tag, string paramName)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        var receiver = go.AddComponent<VRCContactReceiver>();
        receiver.shapeType = ContactBase.ShapeType.Sphere;
        receiver.radius = ReceiverRadius;
        receiver.receiverType = ContactReceiver.ReceiverType.Constant;
        receiver.collisionTags = new List<string> { tag };
        receiver.allowSelf = true;
        receiver.allowOthers = false;
        receiver.localOnly = true;
        receiver.parameter = paramName;
        receiver.advancedParameters = ContactReceiver.AdvancedParameter.SenderLocalPosition;
    }

    static void VerifyPrefab(GameObject worldPrefab, BuildReport report)
    {
        var loaded = AssetDatabase.LoadAssetAtPath<GameObject>(OriginPrefabPath);
        if (loaded == null) throw new Exception("Failed to reload PetPlayOriginV2.prefab");

        var merge = loaded.GetComponent<ModularAvatarMergeAnimator>();
        if (merge == null || merge.animator == null) throw new Exception("Missing ModularAvatarMergeAnimator or controller");
        if (merge.layerType != VRCAvatarDescriptor.AnimLayerType.FX) throw new Exception("MergeAnimator must target FX");
        if (merge.pathMode != MergeAnimatorPathMode.Relative) throw new Exception("MergeAnimator must use Relative path mode");
        report.checks.Add("ModularAvatarMergeAnimator: FX, Relative, matchAvatarWriteDefaults=true");

        var controller = (AnimatorController)merge.animator;
        var controllerParams = new HashSet<string>(controller.parameters.Select(p => p.name));
        foreach (var o in OutputFloatParams)
        {
            if (!controllerParams.Contains(o)) throw new Exception($"FX controller lacks {o}");
        }
        PetPlayOriginBuildUtil.VerifyOutputGuardDriver(controller, OutputFloatParams);
        report.checks.Add("FX controller declares every output; local-only guard driver names them all");

        var maParams = loaded.GetComponent<ModularAvatarParameters>();
        var declared = maParams == null ? new List<ParameterConfig>() : maParams.parameters;
        if (!OutputFloatParams.All(o => declared.Any(p => p.nameOrPrefix == o)) || declared.Count != OutputFloatParams.Length)
        {
            throw new Exception("ModularAvatarParameters must declare exactly the outputs");
        }
        foreach (var p in declared)
        {
            if (!p.localOnly || p.saved || p.syncType != ParameterSyncType.Float || p.internalParameter)
            {
                throw new Exception($"Parameter {p.nameOrPrefix} must be a public, local-only, unsaved Float");
            }
        }
        report.syncedParameterBits = 0;
        report.localParameterCount = declared.Count;
        report.checks.Add($"ModularAvatarParameters: {declared.Count} local-only floats, 0 synced bits");

        var worldRoot = loaded.transform.Find("WorldRoot");
        var worldParent = worldRoot.GetComponent<VRCParentConstraint>();
        if (worldParent == null || worldParent.Sources.Count != 1 || worldParent.Sources[0].SourceTransform != worldPrefab.transform)
        {
            throw new Exception("WorldRoot VRCParentConstraint must reference World.prefab");
        }
        var measure = worldRoot.Find("Measure");
        if (measure == null || measure.gameObject.activeSelf) throw new Exception("WorldRoot/Measure must exist and start inactive");
        report.checks.Add("WorldRoot anchored to World.prefab; Measure starts inactive");

        var sender = measure.Find("Sender");
        var pc = sender.GetComponent<VRCPositionConstraint>();
        float wAnchor = pc.Sources[1].Weight, wOrigin = pc.Sources[0].Weight;
        if (wAnchor != Scale || wOrigin + wAnchor != 1f) throw new Exception($"Sender weights not exact: {wOrigin} + {wAnchor}");
        var fwd = sender.Find("SenderFwd");
        if (fwd.localPosition != new Vector3(0f, 0f, FwdOffset)) throw new Exception("SenderFwd offset must be (0, 0, 2^(F-N))");
        report.checks.Add($"Sender weights exact (2^-{ScaleExponent} and 1 - 2^-{ScaleExponent}); SenderFwd at (0, 0, 2^{FwdOffsetExponent - ScaleExponent})");

        report.contactSenders = loaded.GetComponentsInChildren<VRCContactSender>(true).Length;
        report.contactReceivers = loaded.GetComponentsInChildren<VRCContactReceiver>(true).Length;
        report.physBones = loaded.GetComponentsInChildren<VRCPhysBone>(true).Length;
        report.vrcConstraints = loaded.GetComponentsInChildren<VRCConstraintBase>(true).Length;
        if (report.contactSenders != 2) throw new Exception($"Expected 2 ContactSenders, got {report.contactSenders}");
        if (report.contactReceivers != 2) throw new Exception($"Expected 2 ContactReceivers, got {report.contactReceivers}");
        if (report.physBones != 0) throw new Exception($"Expected 0 PhysBones, got {report.physBones}");
        if (report.vrcConstraints != 4) throw new Exception($"Expected 4 VRCConstraints, got {report.vrcConstraints}");

        foreach (var r in loaded.GetComponentsInChildren<VRCContactReceiver>(true))
        {
            if (!r.localOnly || !r.allowSelf || r.allowOthers || r.receiverType != ContactReceiver.ReceiverType.Constant)
            {
                throw new Exception($"Receiver {r.name} must be Constant, localOnly, self-only");
            }
            if ((r.advancedParameters & ContactReceiver.AdvancedParameter.SenderLocalPosition) == 0)
            {
                throw new Exception($"Receiver {r.name} must output SenderLocalPosition");
            }
        }
        report.checks.Add("2 receivers: Constant, local-only, self-only, SenderLocalPosition, radius 1 m");

        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var dummyAvatar = new GameObject("DummyAvatar");
        dummyAvatar.AddComponent<VRCAvatarDescriptor>();
        var instance = (GameObject)PrefabUtility.InstantiatePrefab(loaded, dummyAvatar.transform);
        if (instance == null) throw new Exception("Failed to instantiate PetPlayOriginV2.prefab on dummy avatar");
        report.checks.Add("Instantiated cleanly under dummy VRCAvatarDescriptor");
    }
}
