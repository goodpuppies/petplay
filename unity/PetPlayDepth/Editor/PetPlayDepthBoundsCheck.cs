// Inspect the saved debug avatar before and after the real SDK/NDMF build callbacks.
// With -petplayDepthFixBounds, update only the debug avatar's existing local FX clips.
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDKBase.Editor.BuildPipeline;

public static class PetPlayDepthBoundsCheck
{
    public static void RunBatch()
    {
        GameObject copy = null;
        try
        {
            var scene = EditorSceneManager.OpenScene("Assets/VRUnityGenerated/Velle-PetPlayDepth.unity");
            var avatar = scene.GetRootGameObjects().SelectMany(g => g.GetComponentsInChildren<VRCAvatarDescriptor>(true)).Single();
            var report = "AUTHORING\n" + Describe(avatar.gameObject);
            var args = Environment.GetCommandLineArgs();
            if (args.Contains("-petplayDepthFixBounds"))
            {
                foreach (var name in new[] { "PetPlayDepthLocalOn", "PetPlayDepthLocalOff" })
                {
                    var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>("Assets/PetPlayDepth/Generated/" + name + ".anim");
                    if (!clip) throw new Exception("missing local clip " + name);
                    PetPlayDepthAvatarBuilder.AddExporterBoundsCurves(clip);
                    EditorUtility.SetDirty(clip);
                }
                AssetDatabase.SaveAssets();
            }
            copy = UnityEngine.Object.Instantiate(avatar.gameObject);
            if (!VRCBuildPipelineCallbacks.OnPreprocessAvatar(copy)) throw new Exception("SDK preprocess failed");
            report += "\nPROCESSED\n" + Describe(copy);
            var clips = copy.GetComponentsInChildren<Animator>(true)
                .Where(a => a.runtimeAnimatorController).SelectMany(a => a.runtimeAnimatorController.animationClips)
                .Concat(copy.GetComponent<VRCAvatarDescriptor>().baseAnimationLayers
                    .Where(l => l.animatorController).SelectMany(l => l.animatorController.animationClips)).Distinct();
            int verifiedClips = 0;
            foreach (var clip in clips)
            {
                var bindings = AnimationUtility.GetCurveBindings(clip)
                    .Where(b => b.path.EndsWith("Local/Depth Exporter") && (b.propertyName.Contains("AABB") || b.propertyName.Contains("UpdateWhenOffscreen"))).ToArray();
                if (bindings.Length == 0) continue;
                if (bindings.Length != 7) throw new Exception("Incomplete bounds bindings in " + clip.name);
                verifiedClips++;
                report += "\nANIMATION " + clip.name + ": " + string.Join(", ", bindings.Select(b => b.propertyName));
                // Confirm Unity actually applies the serialized property bindings, rather than
                // merely retaining their names through NDMF.
                var local = copy.transform.Find("PetPlay Depth");
                var renderer = local.Find("Local/Depth Exporter").GetComponent<SkinnedMeshRenderer>();
                renderer.localBounds = new Bounds(Vector3.zero, Vector3.one);
                renderer.updateWhenOffscreen = true;
                AnimationMode.StartAnimationMode();
                try
                {
                    AnimationMode.BeginSampling();
                    AnimationMode.SampleAnimationClip(copy, clip, 0);
                    AnimationMode.EndSampling();
                    report += "\nSAMPLED " + renderer.localBounds + " offscreen=" + renderer.updateWhenOffscreen;
                    if (renderer.localBounds.extents.x < 999 || renderer.updateWhenOffscreen)
                        throw new Exception("Bounds animation did not apply to exporter");
                }
                finally { AnimationMode.StopAnimationMode(); }
            }
            if (args.Contains("-petplayDepthFixBounds") && verifiedClips < 2)
                throw new Exception("Expected both processed On and Off clips to retain bounds bindings");
            var i = Array.IndexOf(args, "-petplayDepthReport");
            var path = i >= 0 ? args[i + 1] : "Library/PetPlayDepth/bounds.txt";
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, report);
            Debug.Log("[PetPlayDepthBounds] " + report);
            UnityEngine.Object.DestroyImmediate(copy);
            EditorApplication.Exit(0);
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            if (copy) UnityEngine.Object.DestroyImmediate(copy);
            EditorApplication.Exit(1);
        }
    }

    static string Describe(GameObject root)
    {
        return string.Join("\n", root.GetComponentsInChildren<SkinnedMeshRenderer>(true)
            .Where(r => r.name.Contains("Exporter") || r.sharedMaterials.Any(m => m && m.shader && m.shader.name == "PetPlay/DepthExporter"))
            .Select(r => $"{r.name}: bounds={r.localBounds} meshBounds={(r.sharedMesh ? r.sharedMesh.bounds.ToString() : "null")} offscreen={r.updateWhenOffscreen} rootBone={r.rootBone} vertices={(r.sharedMesh ? r.sharedMesh.vertexCount : 0)}"));
    }
}
