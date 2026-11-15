// Builds the PetPlay depth debug variant of Velle: a copy of the base scene's active avatar plus
// the depth exporter, a depth light, a local-only toggle and CustomObjectSync.
// Plan: petplay markdown/vrchat-depth/README.md. Canonical source: petplay
// unity/PetPlayDepth/Editor/; installed into Velle2025 at Assets/PetPlayDepth/Editor/.
//
// Batch:
//   Unity -batchmode -force-vulkan -projectPath <Velle2025> \
//     -executeMethod PetPlayDepthAvatarBuilder.RunBatch -petplayDepthReport <report.json> [-petplayDepthRebuild]
//
// It never saves the source scene and never uploads. The variant's blueprint ID is cleared so it
// gets its own upload slot.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using VRC.Core;
using VRC.Dynamics;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
using VRC.SDK3.Dynamics.Constraint.Components;

public static class PetPlayDepthAvatarBuilder
{
    const string SourceScene = "Assets/SCENES/main.unity";
    const string TargetScene = "Assets/VRUnityGenerated/Velle-PetPlayDepth.unity";
    const string GeneratedDir = "Assets/PetPlayDepth/Generated";
    const string ShaderName = "PetPlay/DepthExporter";
    const string GrabTestShaderName = "PetPlay/GrabShareTest";
    const string GrabTestPath = "Local/Grab Share Test";
    const string AvatarName = "Velle PetPlayDepth";
    const string MenuName = "PetPlay";
    const float ExporterDistance = 0.25f;
    // The avatar's own depth camera (exporter `_Source` 1): at the viewpoint, wide enough for a
    // Quest 3 eye (~96 degrees vertical) with margin for the other eye and head motion.
    const string DepthCameraPath = "Local/Depth Exporter/Depth Camera";
    public const int DepthCameraWidth = 640, DepthCameraHeight = 512;
    public const float DepthCameraFovY = 110, DepthCameraNear = 0.05f, DepthCameraFar = 500;

    [Serializable]
    class Report
    {
        public bool ok;
        public string error = "";
        public string scene = TargetScene;
        public string sourceAvatarPath = "";
        public int removedAvatarRoots;
        public bool blueprintCleared;
        public bool blueprintKept;
        public string headBone = "";
        public float[] anchorOffset = new float[0];   // the viewpoint in the exporter's object space
        public int parameterCost;
        public int topMenuControls;
        public bool customObjectSync;
        public string fxWriteDefaults = "";
        public List<string> created = new List<string>();
        public List<string> notes = new List<string>();
    }

    public static void RunBatch()
    {
        var args = Environment.GetCommandLineArgs();
        string reportPath = ArgAfter(args, "-petplayDepthReport") ?? "Library/PetPlayDepth/report.json";
        bool rebuild = args.Contains("-petplayDepthRebuild");
        var report = new Report();
        int code = 1;
        try
        {
            Build(report, rebuild);
            report.ok = true;
            code = 0;
        }
        catch (Exception e)
        {
            report.error = e.ToString();
            Debug.LogError("[PetPlayDepth] " + e);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(reportPath)));
        File.WriteAllText(reportPath, JsonUtility.ToJson(report, true));
        EditorApplication.Exit(code);
    }

    static string ArgAfter(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    static void Build(Report report, bool rebuild)
    {
        if (EditorSceneManager.GetActiveScene().isDirty) throw new Exception("the open scene has unsaved changes");
        // A rebuild keeps the variant's own upload slot: read its blueprint ID before replacing it.
        string keptBlueprint = "";
        if (AssetDatabase.LoadAssetAtPath<SceneAsset>(TargetScene) != null)
        {
            if (!rebuild) throw new Exception($"{TargetScene} exists; pass -petplayDepthRebuild to replace it");
            var previous = EditorSceneManager.OpenScene(TargetScene, OpenSceneMode.Single);
            var ids = previous.GetRootGameObjects()
                .SelectMany(r => r.GetComponentsInChildren<PipelineManager>(true))
                .Select(p => p.blueprintId).Where(id => !string.IsNullOrEmpty(id)).Distinct().ToList();
            if (ids.Count > 1) throw new Exception($"{TargetScene} has {ids.Count} blueprint IDs");
            keptBlueprint = ids.FirstOrDefault() ?? "";
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AssetDatabase.DeleteAsset(TargetScene);
            AssetDatabase.DeleteAsset(GeneratedDir);
        }
        else if (AssetDatabase.IsValidFolder(GeneratedDir))
        {
            throw new Exception($"{GeneratedDir} exists without the scene; remove it or pass -petplayDepthRebuild");
        }
        var shader = Shader.Find(ShaderName);
        if (shader == null) throw new Exception($"shader {ShaderName} not found (not imported, or it failed to compile)");
        EnsureFolder(GeneratedDir);
        if (!AssetDatabase.CopyAsset(SourceScene, TargetScene)) throw new Exception($"could not copy {SourceScene}");
        var scene = EditorSceneManager.OpenScene(TargetScene, OpenSceneMode.Single);

        // The single active avatar; every other avatar root goes, so the copy holds one avatar.
        var descriptors = scene.GetRootGameObjects()
            .SelectMany(r => r.GetComponentsInChildren<VRCAvatarDescriptor>(true)).ToList();
        var active = descriptors.Where(d => d.gameObject.activeInHierarchy).ToList();
        if (active.Count != 1) throw new Exception($"expected one active avatar, found {active.Count}");
        var avatar = active[0];
        report.sourceAvatarPath = PathOf(avatar.transform);
        foreach (var root in scene.GetRootGameObjects())
        {
            if (root == avatar.transform.root.gameObject) continue;
            if (root.GetComponentsInChildren<VRCAvatarDescriptor>(true).Length == 0) continue;
            UnityEngine.Object.DestroyImmediate(root);
            report.removedAvatarRoots++;
        }
        foreach (var d in avatar.GetComponentsInChildren<VRCAvatarDescriptor>(true))
        {
            if (d != avatar) throw new Exception($"nested avatar descriptor at {PathOf(d.transform)}");
        }
        avatar.gameObject.name = AvatarName;

        // Never the source avatar's upload slot: the variant's own ID from a previous build, or none.
        var pipeline = avatar.GetComponent<PipelineManager>();
        if (pipeline == null && keptBlueprint != "") pipeline = avatar.gameObject.AddComponent<PipelineManager>();
        if (pipeline != null && pipeline.blueprintId != keptBlueprint)
        {
            report.blueprintCleared = !string.IsNullOrEmpty(pipeline.blueprintId);
            pipeline.blueprintId = keptBlueprint;
            EditorUtility.SetDirty(pipeline);
            PrefabUtility.RecordPrefabInstancePropertyModifications(pipeline);
        }
        report.blueprintKept = keptBlueprint != "";

        // Own copies of the parameters and menu: CustomObjectSync edits them in place.
        avatar.expressionParameters = CopyAsset(avatar.expressionParameters, "Parameters.asset");
        avatar.expressionsMenu = CopyAsset(avatar.expressionsMenu, "Menu.asset");
        if (avatar.expressionsMenu == null || avatar.expressionParameters == null)
        {
            throw new Exception("the avatar has no expression menu or parameters to extend");
        }
        if (avatar.expressionsMenu.controls.Count >= VRCExpressionsMenu.MAX_CONTROLS)
        {
            throw new Exception($"top-level menu is full ({avatar.expressionsMenu.controls.Count} controls)");
        }
        var petplayMenu = ScriptableObject.CreateInstance<VRCExpressionsMenu>();
        petplayMenu.controls = new List<VRCExpressionsMenu.Control>();
        AssetDatabase.CreateAsset(petplayMenu, $"{GeneratedDir}/PetPlayMenu.asset");
        avatar.expressionsMenu.controls.Add(new VRCExpressionsMenu.Control
        {
            name = MenuName,
            type = VRCExpressionsMenu.Control.ControlType.SubMenu,
            subMenu = petplayMenu,
        });
        EditorUtility.SetDirty(avatar.expressionsMenu);
        EditorUtility.SetDirty(avatar);

        var animator = avatar.GetComponent<Animator>();
        var head = animator != null ? animator.GetBoneTransform(HumanBodyBones.Head) : null;
        if (head == null) throw new Exception("no humanoid head bone");
        report.headBone = PathOf(head);

        BuildDepthObjects(avatar, head, shader, report);
        BuildCustomObjectSync(avatar, report);

        report.parameterCost = avatar.expressionParameters.CalcTotalCost();
        report.topMenuControls = avatar.expressionsMenu.controls.Count;
        if (report.parameterCost > VRCExpressionParameters.MAX_PARAMETER_COST)
        {
            report.notes.Add($"parameter cost {report.parameterCost} is over the {VRCExpressionParameters.MAX_PARAMETER_COST} limit");
        }
        AssetDatabase.SaveAssets();
        if (!EditorSceneManager.SaveScene(scene)) throw new Exception("saving the scene failed");
    }

    static void BuildDepthObjects(VRCAvatarDescriptor avatar, Transform head, Shader shader, Report report)
    {
        var root = avatar.transform;
        // "PetPlay Depth" stays active and holds the toggle; "Local" is off unless IsLocal.
        var container = new GameObject("PetPlay Depth");
        container.transform.SetParent(root, false);
        var local = new GameObject("Local");
        local.transform.SetParent(container.transform, false);
        local.SetActive(false);

        // A black shadowed directional light makes Unity render _CameraDepthTexture.
        var lightObject = new GameObject("Depth Light");
        lightObject.transform.SetParent(local.transform, false);
        lightObject.transform.localRotation = Quaternion.Euler(90, 0, 0);
        var light = lightObject.AddComponent<Light>();
        light.type = LightType.Directional;
        light.color = Color.black;
        light.intensity = 1;
        light.shadows = LightShadows.Hard;
        light.renderMode = LightRenderMode.ForcePixel;
        light.cullingMask = ~0;
        light.enabled = false;   // PetPlayDepth/Source defaults to the depth camera, which doesn't need it
        report.created.Add(PathOf(lightObject.transform));

        // The exporter quad: in front of the face, following the head through a constraint.
        var exporter = new GameObject("Depth Exporter");
        exporter.transform.SetParent(local.transform, false);
        exporter.transform.position = head.position + root.forward * ExporterDistance;
        exporter.transform.rotation = root.rotation;
        exporter.transform.localScale = Vector3.one;
        // A skinned renderer with huge saved bounds: every camera draws it (the vertex shader puts
        // the block in screen space), including VRChat's handheld camera looking away from us.
        var renderer = exporter.AddComponent<SkinnedMeshRenderer>();
        renderer.sharedMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
        renderer.rootBone = exporter.transform;
        renderer.updateWhenOffscreen = false;
        renderer.localBounds = new Bounds(Vector3.zero, Vector3.one * 2000);
        var material = new Material(shader) { name = "PetPlay Depth Exporter" };
        // The anchor is the avatar's viewpoint, the point VRChat keeps at the headset's centre eye,
        // so the header's anchorToWorld is the headset pose in VRChat's world. Object space of the
        // exporter, which keeps its offset from the head through the constraint.
        var viewpoint = exporter.transform.InverseTransformPoint(root.TransformPoint(avatar.ViewPosition));
        material.SetVector("_AnchorOffset", new Vector4(viewpoint.x, viewpoint.y, viewpoint.z, 0));
        report.anchorOffset = new[] { viewpoint.x, viewpoint.y, viewpoint.z };
        AssetDatabase.CreateAsset(material, $"{GeneratedDir}/DepthExporter.mat");
        renderer.sharedMaterial = material;
        renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        renderer.receiveShadows = false;
        renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
        renderer.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
        renderer.allowOcclusionWhenDynamic = false;
        BuildDepthCamera(exporter.transform, viewpoint, material, report);
        var constraint = exporter.AddComponent<VRCParentConstraint>();
        constraint.Sources.Add(new VRCConstraintSource { SourceTransform = head, Weight = 1 });
        constraint.ActivateConstraint();
        report.created.Add(PathOf(exporter.transform));

        // Local-only: remote copies of this avatar never force a depth pass or draw the block.
        // PetPlayDepth/Enabled (local, default on) lets PetPlay or the wearer hide it.
        var on = Clip("PetPlayDepthLocalOn", 1);
        var off = Clip("PetPlayDepthLocalOff", 0);
        var controller = AnimatorController.CreateAnimatorControllerAtPath($"{GeneratedDir}/PetPlayDepthLocal.controller");
        controller.AddParameter("IsLocal", AnimatorControllerParameterType.Bool);
        controller.AddParameter(new AnimatorControllerParameter
        {
            name = EnabledParameter,
            type = AnimatorControllerParameterType.Bool,
            defaultBool = true,
        });
        var machine = controller.layers[0].stateMachine;
        var layers = controller.layers;
        layers[0].name = "PetPlay Depth Local";
        layers[0].defaultWeight = 1;
        controller.layers = layers;
        var offState = machine.AddState("Off");
        offState.motion = off;
        var onState = machine.AddState("On");
        onState.motion = on;
        machine.defaultState = offState;
        var toOn = offState.AddTransition(onState);
        toOn.hasExitTime = false;
        toOn.duration = 0;
        toOn.AddCondition(AnimatorConditionMode.If, 0, "IsLocal");
        toOn.AddCondition(AnimatorConditionMode.If, 0, EnabledParameter);
        foreach (var parameter in new[] { "IsLocal", EnabledParameter })
        {
            var toOff = onState.AddTransition(offState);
            toOff.hasExitTime = false;
            toOff.duration = 0;
            toOff.AddCondition(AnimatorConditionMode.IfNot, 0, parameter);
        }

        // Block layout is tunable at runtime through local (unsynced, zero-cost) float parameters,
        // so finding where the block survives the desktop window needs no re-upload. Each maps
        // 0..1 linearly onto a material property range; the shader rounds where it needs integers.
        var expression = avatar.expressionParameters.parameters.ToList();
        expression.Add(new VRCExpressionParameters.Parameter
        {
            name = EnabledParameter,
            valueType = VRCExpressionParameters.ValueType.Bool,
            defaultValue = 1,
            saved = false,
            networkSynced = false,
        });
        foreach (var t in Tunables)
        {
            float normalized = (t.Default - t.Min) / (t.Max - t.Min);
            foreach (var property in t.Properties) material.SetFloat(property, t.Default);
            controller.AddParameter(new AnimatorControllerParameter
            {
                name = t.Parameter,
                type = AnimatorControllerParameterType.Float,
                defaultFloat = normalized,
            });
            expression.Add(new VRCExpressionParameters.Parameter
            {
                name = t.Parameter,
                valueType = VRCExpressionParameters.ValueType.Float,
                defaultValue = normalized,
                saved = false,
                networkSynced = false,
            });
            var tree = new BlendTree
            {
                name = t.Parameter,
                blendType = BlendTreeType.Simple1D,
                blendParameter = t.Parameter,
                useAutomaticThresholds = false,
            };
            AssetDatabase.AddObjectToAsset(tree, controller);
            tree.AddChild(PropertyClip(t, t.Min), 0);
            tree.AddChild(PropertyClip(t, t.Max), 1);
            controller.AddLayer(t.Parameter);
            var all = controller.layers;
            var layer = all[all.Length - 1];
            layer.defaultWeight = 1;
            var state = layer.stateMachine.AddState(t.Parameter.Replace('/', ' '));
            state.motion = tree;
            controller.layers = all;
        }
        EditorUtility.SetDirty(material);
        var merge = container.AddComponent<ModularAvatarMergeAnimator>();
        merge.animator = controller;
        merge.layerType = VRCAvatarDescriptor.AnimLayerType.FX;
        merge.pathMode = MergeAnimatorPathMode.Relative;
        BuildGrabShareTest(local.transform, exporter.transform, controller, expression, report);
        avatar.expressionParameters.parameters = expression.ToArray();
        EditorUtility.SetDirty(avatar.expressionParameters);
        EditorUtility.SetDirty(controller);
        merge.matchAvatarWriteDefaults = true;   // Velle's FX writes defaults in every state
        report.created.Add(PathOf(container.transform));
    }

    // Experiment (PetPlayGrabShareTest.shader): does a named GrabPass from the eye pass reach
    // VRChat's camera pass? Inactive unless PetPlayDepth/GrabTest (local, unsynced, default off).
    static void BuildGrabShareTest(Transform local, Transform exporter, AnimatorController controller,
        List<VRCExpressionParameters.Parameter> expression, Report report)
    {
        var shader = Shader.Find(GrabTestShaderName);
        if (shader == null) throw new Exception($"shader {GrabTestShaderName} not found (not imported, or it failed to compile)");
        var test = new GameObject("Grab Share Test");
        test.transform.SetParent(local, false);
        test.transform.SetPositionAndRotation(exporter.position, exporter.rotation);
        var renderer = test.AddComponent<SkinnedMeshRenderer>();
        renderer.sharedMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
        renderer.rootBone = test.transform;
        renderer.updateWhenOffscreen = false;
        renderer.localBounds = new Bounds(Vector3.zero, Vector3.one * 2000);
        var material = new Material(shader) { name = "PetPlay Grab Share Test" };
        AssetDatabase.CreateAsset(material, $"{GeneratedDir}/GrabShareTest.mat");
        renderer.sharedMaterial = material;
        renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        renderer.receiveShadows = false;
        renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
        renderer.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
        renderer.allowOcclusionWhenDynamic = false;
        var constraint = test.AddComponent<VRCParentConstraint>();
        constraint.Sources.Add(new VRCConstraintSource { SourceTransform = exporter.GetComponent<VRCParentConstraint>().Sources[0].SourceTransform, Weight = 1 });
        constraint.ActivateConstraint();
        test.SetActive(false);

        controller.AddParameter(GrabTestParameter, AnimatorControllerParameterType.Bool);
        expression.Add(new VRCExpressionParameters.Parameter
        {
            name = GrabTestParameter,
            valueType = VRCExpressionParameters.ValueType.Bool,
            defaultValue = 0,
            saved = false,
            networkSynced = false,
        });
        controller.AddLayer("PetPlay Grab Share Test");
        var all = controller.layers;
        var layer = all[all.Length - 1];
        layer.defaultWeight = 1;
        var offState = layer.stateMachine.AddState("Off");
        offState.motion = ActiveClip("PetPlayGrabTestOff", GrabTestPath, 0);
        var onState = layer.stateMachine.AddState("On");
        onState.motion = ActiveClip("PetPlayGrabTestOn", GrabTestPath, 1);
        layer.stateMachine.defaultState = offState;
        var toOn = offState.AddTransition(onState);
        toOn.hasExitTime = false;
        toOn.duration = 0;
        toOn.AddCondition(AnimatorConditionMode.If, 0, GrabTestParameter);
        var toOff = onState.AddTransition(offState);
        toOff.hasExitTime = false;
        toOff.duration = 0;
        toOff.AddCondition(AnimatorConditionMode.IfNot, 0, GrabTestParameter);
        controller.layers = all;
        report.created.Add(PathOf(test.transform));
    }

    const string GrabTestParameter = "PetPlayDepth/GrabTest";

    static AnimationClip ActiveClip(string name, string path, float active)
    {
        var clip = new AnimationClip { name = name };
        clip.SetCurve(path, typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0, 1 / 60f, active));
        AddBoundsCurves(clip, path);
        AssetDatabase.CreateAsset(clip, $"{GeneratedDir}/{name}.anim");
        return clip;
    }

    // A camera at the viewpoint (the anchor) with the exporter's rotation, rendering scene depth
    // into its own Depth-format target, which the exporter reads in VRChat's camera pass. Hand
    // Fitter's pattern; the Stream camera then only carries the block out and never has to move.
    static void BuildDepthCamera(Transform exporter, Vector3 viewpoint, Material material, Report report)
    {
        var target = new RenderTexture(DepthCameraWidth, DepthCameraHeight, 24, RenderTextureFormat.Depth)
        {
            name = "PetPlay Depth Camera",
            filterMode = FilterMode.Point,
            wrapMode = TextureWrapMode.Clamp,
            useMipMap = false,
            autoGenerateMips = false,
            antiAliasing = 1,
        };
        AssetDatabase.CreateAsset(target, $"{GeneratedDir}/DepthCamera.renderTexture");
        var cameraObject = new GameObject("Depth Camera");
        cameraObject.transform.SetParent(exporter, false);
        cameraObject.transform.localPosition = viewpoint;
        cameraObject.transform.localRotation = Quaternion.identity;
        var camera = cameraObject.AddComponent<Camera>();
        ConfigureDepthCamera(camera, target);
        float tanHalfY = Mathf.Tan(DepthCameraFovY * 0.5f * Mathf.Deg2Rad);
        material.SetTexture("_DepthCamTex", target);
        material.SetFloat("_DepthCamNear", DepthCameraNear);
        material.SetFloat("_DepthCamFar", DepthCameraFar);
        material.SetFloat("_DepthCamTanHalfY", tanHalfY);
        material.SetFloat("_DepthCamAspect", DepthCameraWidth / (float)DepthCameraHeight);
        report.created.Add(PathOf(cameraObject.transform));
    }

    public static void ConfigureDepthCamera(Camera camera, RenderTexture target)
    {
        camera.targetTexture = target;
        camera.fieldOfView = DepthCameraFovY;
        camera.nearClipPlane = DepthCameraNear;
        camera.farClipPlane = DepthCameraFar;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = Color.black;
        // Not UI (5), UiMenu (12), MirrorReflection (18) or InternalUI (19).
        camera.cullingMask = ~((1 << 5) | (1 << 12) | (1 << 18) | (1 << 19));
        camera.depth = -50;   // before the Stream camera, which reads the target the same frame
        camera.allowHDR = false;
        camera.allowMSAA = false;
        camera.useOcclusionCulling = true;
        camera.depthTextureMode = DepthTextureMode.None;
    }

    struct Tunable
    {
        public string Parameter;
        public string[] Properties;
        public float Min, Max, Default;
        public Tunable(string parameter, string properties, float min, float max, float value)
        {
            Parameter = parameter; Properties = properties.Split(','); Min = min; Max = max; Default = value;
        }
    }

    const string EnabledParameter = "PetPlayDepth/Enabled";
    const string SourceParameter = "PetPlayDepth/Source";

    static readonly Tunable[] Tunables =
    {
        new Tunable("PetPlayDepth/OriginX", "_OriginX", 0, 4096, 64),
        new Tunable("PetPlayDepth/OriginY", "_OriginY", 0, 4096, 64),
        new Tunable("PetPlayDepth/CellPx", "_CellPx", 1, 9, 2),
        new Tunable("PetPlayDepth/Bits", "_BitsR,_BitsG,_BitsB", 1, 8, 6),
        // Ranges sized for a Bigscreen Beyond 2e class eye (3562 px recommended per eye).
        new Tunable("PetPlayDepth/DepthSize", "_DepthWidth,_DepthHeight", 16, 512, 128),
        new Tunable("PetPlayDepth/GridWidth", "_GridWidth", 64, 1024, 256),
        new Tunable("PetPlayDepth/Eye", "_Eye", 0, 1, 0),
        new Tunable("PetPlayDepth/Target", "_Target", 0, 1, 0),
        new Tunable("PetPlayDepth/FlipImageY", "_FlipImageY", 0, 1, 0),
        new Tunable("PetPlayDepth/Calibration3D", "_Calibration3D", 0, 1, 0),
        new Tunable("PetPlayDepth/LevelInset", "_LevelInset", 0, 64, 0),
        // 0: the pass's own depth texture (needs the depth light); 1: the avatar's depth camera.
        new Tunable(SourceParameter, "_Source", 0, 1, 1),
    };

    static AnimationClip PropertyClip(Tunable t, float value)
    {
        string name = $"{t.Parameter.Replace('/', '_')}_{value}";
        var clip = new AnimationClip { name = name };
        foreach (var property in t.Properties)
        {
            clip.SetCurve("Local/Depth Exporter", typeof(SkinnedMeshRenderer), "material." + property, AnimationCurve.Constant(0, 1 / 60f, value));
        }
        if (t.Parameter == SourceParameter)
        {
            // The depth camera runs only as the source; the depth light only when it isn't.
            clip.SetCurve(DepthCameraPath, typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0, 1 / 60f, value));
            clip.SetCurve("Local/Depth Light", typeof(Light), "m_Enabled", AnimationCurve.Constant(0, 1 / 60f, 1 - value));
        }
        AssetDatabase.CreateAsset(clip, $"{GeneratedDir}/{name}.anim");
        return clip;
    }

    static AnimationClip Clip(string name, float active)
    {
        var clip = new AnimationClip { name = name };
        clip.SetCurve("Local", typeof(GameObject), "m_IsActive", AnimationCurve.Constant(0, 1 / 60f, active));
        AddExporterBoundsCurves(clip);
        AssetDatabase.CreateAsset(clip, $"{GeneratedDir}/{name}.anim");
        return clip;
    }

    // Keep the screen-space quad's culling bounds even if the client changes offscreen skinning.
    // Apply only to our four-vertex exporter, never to the avatar's body/clothing renderers.
    public static void AddExporterBoundsCurves(AnimationClip clip) => AddBoundsCurves(clip, "Local/Depth Exporter");

    static void AddBoundsCurves(AnimationClip clip, string path)
    {
        clip.SetCurve(path, typeof(SkinnedMeshRenderer), "m_UpdateWhenOffscreen", AnimationCurve.Constant(0, 1 / 60f, 0));
        foreach (var axis in new[] { "x", "y", "z" })
        {
            clip.SetCurve(path, typeof(SkinnedMeshRenderer), "m_AABB.m_Center." + axis, AnimationCurve.Constant(0, 1 / 60f, 0));
            clip.SetCurve(path, typeof(SkinnedMeshRenderer), "m_AABB.m_Extent." + axis, AnimationCurve.Constant(0, 1 / 60f, 1000));
        }
    }

    static void BuildCustomObjectSync(VRCAvatarDescriptor avatar, Report report)
    {
        // The tracked object sits at the avatar root: its world position and yaw are what
        // petplay/VRCOrigin.ts combines with the HMD pose to place the world origin.
        var tracker = new GameObject("PetPlay Origin Sync");
        tracker.transform.SetParent(avatar.transform, false);

        var fx = avatar.baseAnimationLayers.FirstOrDefault(l => l.type == VRCAvatarDescriptor.AnimLayerType.FX).animatorController as AnimatorController;
        bool writeDefaults = true;
        if (fx != null)
        {
            var states = fx.layers.SelectMany(l => l.stateMachine.states).Select(s => s.state).ToList();
            int on = states.Count(s => s.writeDefaultValues);
            report.fxWriteDefaults = $"{on} of {states.Count} states write defaults";
            writeDefaults = on * 2 >= states.Count;
        }

        var creator = VRLabs.CustomObjectSyncCreator.CustomObjectSyncCreator.instance;
        creator.resourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(
            AssetDatabase.GUIDToAssetPath("d51eb264fa89a5b4d9b95f344f169766"));
        if (creator.resourcePrefab == null) throw new Exception("CustomObjectSync resource prefab not found");
        creator.useMultipleObjects = false;
        creator.syncObjects = new[] { tracker };
        creator.maxRadius = 8;           // +-256 m; PetPlay decodes (v - 0.5) * 2^(maxRadius + 1)
        creator.positionPrecision = 6;
        creator.rotationPrecision = 8;
        creator.syncRotationX = false;   // PetPlay reads yaw only
        creator.syncRotationY = true;
        creator.syncRotationZ = false;
        creator.centeredOnAvatar = false;
        creator.quickSync = false;
        creator.bitCount = 16;
        creator.addDampeningConstraint = false;
        creator.addLocalDebugView = false;
        creator.writeDefaults = writeDefaults;
        creator.menuLocation = MenuName;
        creator.Generate();
        report.customObjectSync = avatar.expressionParameters.parameters.Any(p => p.name == "CustomObjectSync/Enabled");
        if (!report.customObjectSync) throw new Exception("CustomObjectSync did not add its parameters (see the editor log)");
        report.created.Add(PathOf(tracker.transform));
    }

    static T CopyAsset<T>(T asset, string fileName) where T : UnityEngine.Object
    {
        if (asset == null) return null;
        string path = $"{GeneratedDir}/{fileName}";
        AssetDatabase.DeleteAsset(path);
        if (!AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(asset), path)) throw new Exception($"could not copy {asset.name}");
        return AssetDatabase.LoadAssetAtPath<T>(path);
    }

    static void EnsureFolder(string path)
    {
        if (AssetDatabase.IsValidFolder(path)) return;
        string parent = Path.GetDirectoryName(path).Replace('\\', '/');
        EnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
    }

    static string PathOf(Transform t) => t.parent == null ? t.name : PathOf(t.parent) + "/" + t.name;
}
