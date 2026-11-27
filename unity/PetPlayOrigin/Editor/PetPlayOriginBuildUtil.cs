// Shared editor helpers for the PetPlay Origin prefab builders (v1 and v2).
//
// Canonical source: petplay/unity/PetPlayOrigin/Editor/PetPlayOriginBuildUtil.cs
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDKBase;

public static class PetPlayOriginBuildUtil
{
    public static void EnsureFolder(string path)
    {
        if (AssetDatabase.IsValidFolder(path)) return;
        string parent = Path.GetDirectoryName(path).Replace('\\', '/');
        EnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
    }

    /// Creates the clip, or clears and reuses the existing asset so its GUID (and every reference
    /// to it from avatars that already use the prefab) survives a rebuild.
    public static AnimationClip CreateOrClearClip(string path, string name)
    {
        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(path);
        if (clip == null)
        {
            clip = new AnimationClip { name = name };
            AssetDatabase.CreateAsset(clip, path);
        }
        else
        {
            clip.ClearCurves();
            clip.name = name;
        }
        return clip;
    }

    /// Creates the controller, or empties the existing asset in place (keeping its GUID).
    /// The result has no layers and no parameters.
    public static AnimatorController CreateOrClearController(string path)
    {
        var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
        if (controller == null) controller = AnimatorController.CreateAnimatorControllerAtPath(path);
        while (controller.layers.Length > 0) controller.RemoveLayer(0);
        foreach (var p in controller.parameters.ToArray()) controller.RemoveParameter(p);
        return controller;
    }

    /// Optimizer guard. The origin outputs are written only by contacts / PhysBones and read only
    /// over OSC, so nothing in any animator reads them. d4rk Avatar Optimizer's "Delete Unused
    /// Animator Parameters" (default on) keeps a parameter only when a condition, blend tree or
    /// parameter driver mentions it, and would strip them from the FX controller. A local-only
    /// driver that resets them to 0 on the Remote state counts as a use, keeps the layer from being
    /// merged away as a plain toggle, and is harmless: contacts overwrite the values every frame.
    /// (AAO treats expression parameters as used; VRCFury's compressor only touches synced ones.)
    public static void AddOutputGuardDriver(AnimatorState state, IEnumerable<string> outputs)
    {
        var driver = state.AddStateMachineBehaviour<VRCAvatarParameterDriver>();
        driver.localOnly = true;
        driver.parameters = outputs.Select(p => new VRC_AvatarParameterDriver.Parameter
        {
            type = VRC_AvatarParameterDriver.ChangeType.Set,
            name = p,
            value = 0f,
        }).ToList();
    }

    public static void VerifyOutputGuardDriver(AnimatorController controller, IEnumerable<string> outputs)
    {
        var driven = new HashSet<string>(controller.layers
            .SelectMany(l => l.stateMachine.states)
            .SelectMany(s => s.state.behaviours.OfType<VRCAvatarParameterDriver>())
            .Where(d => d.localOnly)
            .SelectMany(d => d.parameters.Select(p => p.name)));
        var missing = outputs.Where(o => !driven.Contains(o)).ToList();
        if (missing.Count > 0)
        {
            throw new System.Exception("Optimizer guard driver misses: " + string.Join(", ", missing));
        }
    }
}
