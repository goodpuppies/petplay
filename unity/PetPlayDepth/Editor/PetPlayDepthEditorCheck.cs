// Phase 0 check: renders the depth exporter from an ordinary camera in a throwaway scene and
// writes the pixels plus ground truth, for petplay's utils/vrchatDepthEditorCheck.ts to decode.
//
//   Unity -batchmode -force-vulkan -projectPath <project> \
//     -executeMethod PetPlayDepthEditorCheck.RunBatch -petplayDepthOut <directory>
//
// The scene is never saved. Depth comes from a black hard-shadow directional light, as on the
// avatar; the camera does not request a depth texture itself.
using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

public static class PetPlayDepthEditorCheck
{
    const int Size = 1024;
    const int DepthW = 64, DepthH = 64;

    public static void RunBatch()
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, "-petplayDepthOut");
        string outDir = i >= 0 && i + 1 < args.Length ? args[i + 1] : "Library/PetPlayDepth/editor-check";
        int code = 1;
        try
        {
            Run(outDir);
            code = 0;
        }
        catch (Exception e)
        {
            Debug.LogError("[PetPlayDepth] " + e);
            Directory.CreateDirectory(outDir);
            File.WriteAllText(Path.Combine(outDir, "error.txt"), e.ToString());
        }
        EditorApplication.Exit(code);
    }

    static void Run(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var shader = Shader.Find("PetPlay/DepthExporter");
        if (shader == null) throw new Exception("PetPlay/DepthExporter not found");
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        var camObject = new GameObject("Camera");
        camObject.transform.position = new Vector3(0.3f, 1.6f, -0.2f);
        camObject.transform.rotation = Quaternion.Euler(8, 12, 0);
        var cam = camObject.AddComponent<Camera>();
        cam.fieldOfView = 70;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 100;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.2f, 0.3f, 0.5f, 1);
        cam.allowMSAA = false;
        cam.depthTextureMode = DepthTextureMode.None;
        var rt = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        rt.Create();
        cam.targetTexture = rt;

        // Something to light the geometry, and the black shadowed light that forces depth.
        var key = new GameObject("Key").AddComponent<Light>();
        key.type = LightType.Directional;
        key.transform.rotation = Quaternion.Euler(50, -30, 0);
        key.shadows = LightShadows.None;
        var depthLight = new GameObject("Depth Light").AddComponent<Light>();
        depthLight.type = LightType.Directional;
        depthLight.transform.rotation = Quaternion.Euler(90, 0, 0);
        depthLight.color = Color.black;
        depthLight.shadows = LightShadows.Hard;
        depthLight.renderMode = LightRenderMode.ForcePixel;
        QualitySettings.shadows = ShadowQuality.All;
        QualitySettings.shadowDistance = 50;

        Primitive(PrimitiveType.Cube, new Vector3(0, 0, 4.5f), new Vector3(12, 8, 0.2f));   // wall
        Primitive(PrimitiveType.Cube, new Vector3(0.1f, 1.7f, 0.9f), new Vector3(0.35f, 0.35f, 0.35f));
        Primitive(PrimitiveType.Sphere, new Vector3(-0.9f, 1.2f, 2.2f), Vector3.one * 0.8f);
        Primitive(PrimitiveType.Cube, new Vector3(0, -0.05f, 2), new Vector3(12, 0.1f, 12));   // floor

        var quad = new GameObject("Exporter");
        quad.transform.position = cam.transform.position + cam.transform.forward * 0.25f;
        quad.transform.rotation = cam.transform.rotation;
        quad.transform.localScale = new Vector3(0.3f, 0.2f, 1.5f);   // the anchor must drop scale
        quad.AddComponent<MeshFilter>().sharedMesh = Resources.GetBuiltinResource<Mesh>("Quad.fbx");
        var renderer = quad.AddComponent<MeshRenderer>();
        var material = new Material(shader);
        material.SetFloat("_AllowMono", 1);
        material.SetFloat("_GateRadius", 1);
        material.SetVector("_AnchorOffset", new Vector4(0, 0, -0.25f / 1.5f, 0));   // object space
        material.SetFloat("_OriginX", 40);
        material.SetFloat("_OriginY", 40);
        material.SetFloat("_CellPx", 2);
        material.SetFloat("_GridWidth", 128);
        material.SetFloat("_DepthWidth", DepthW);
        material.SetFloat("_DepthHeight", DepthH);
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthCalibration3D") >= 0)
        {
            // 3D colour calibration at 4 bits a channel, levels inset (worlds that grade colours).
            material.SetFloat("_Calibration3D", 1);
            material.SetFloat("_LevelInset", 16);
            material.SetFloat("_BitsR", 4);
            material.SetFloat("_BitsG", 4);
            material.SetFloat("_BitsB", 4);
        }
        renderer.sharedMaterial = material;
        renderer.shadowCastingMode = ShadowCastingMode.Off;

        // -petplayDepthAvatarCamera: depth from an avatar-style depth camera at the anchor (110
        // degrees, its own Depth target), as the builder's "Depth Camera"; the truth follows it.
        Camera depthCam = null;
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthAvatarCamera") >= 0)
        {
            var depthTarget = new RenderTexture(PetPlayDepthAvatarBuilder.DepthCameraWidth,
                PetPlayDepthAvatarBuilder.DepthCameraHeight, 24, RenderTextureFormat.Depth)
            { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
            depthTarget.Create();
            var depthObject = new GameObject("Depth Camera");
            depthObject.transform.SetParent(quad.transform, false);
            depthObject.transform.localPosition = new Vector3(0, 0, -0.25f / 1.5f);   // the anchor
            depthObject.transform.localRotation = Quaternion.identity;
            depthCam = depthObject.AddComponent<Camera>();
            PetPlayDepthAvatarBuilder.ConfigureDepthCamera(depthCam, depthTarget);
            depthCam.enabled = false;   // rendered by hand, before the view camera
            material.SetFloat("_Source", 1);
            material.SetTexture("_DepthCamTex", depthTarget);
            material.SetFloat("_DepthCamNear", PetPlayDepthAvatarBuilder.DepthCameraNear);
            material.SetFloat("_DepthCamFar", PetPlayDepthAvatarBuilder.DepthCameraFar);
            material.SetFloat("_DepthCamTanHalfY", Mathf.Tan(PetPlayDepthAvatarBuilder.DepthCameraFovY * 0.5f * Mathf.Deg2Rad));
            material.SetFloat("_DepthCamAspect", depthTarget.width / (float)depthTarget.height);
        }

        if (Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthLightVolumes") >= 0)
        {
            // Temporary synthetic v2 atlas: no scene/assets are saved by this check.
            bool legacyCheck = Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthLegacyLightVolumes") >= 0;
            bool fineCheck = Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthFineLightVolumes") >= 0;
            bool nativeCheck = Array.IndexOf(Environment.GetCommandLineArgs(), "-petplayDepthNativeLightVolumes") >= 0;
            fineCheck |= nativeCheck;
            int n = fineCheck ? 32 : 16;
            int nx = nativeCheck ? 34 : n, ny = nativeCheck ? 14 : n, nz = nativeCheck ? 22 : n;
            if (fineCheck) material.EnableKeyword("PPD_LV_CHECK_FINE");
            var atlas = new Texture3D(nx * 3, ny, nz, TextureFormat.RGBAFloat, false);
            atlas.filterMode = FilterMode.Bilinear; atlas.wrapMode = TextureWrapMode.Clamp;
            var colors = new Color[nx * 3 * ny * nz];
            for (int z = 0; z < nz; z++) for (int y = 0; y < ny; y++) for (int x = 0; x < nx * 3; x++)
                colors[x + nx * 3 * (y + ny * z)] = x < nx
                    ? new Color(x / (float)(nx - 1), .2f, .1f, .03f)
                    : x < nx * 2 ? new Color(.04f, .05f, .06f, .07f) : new Color(.08f, .09f, .1f, .11f);
            atlas.SetPixels(colors); atlas.Apply();
            Shader.SetGlobalTexture("_UdonLightVolume", atlas);
            Shader.SetGlobalFloat("_UdonLightVolumeVersion", legacyCheck ? 0 : 2);
            Shader.SetGlobalFloat("_UdonLightVolumeEnabled", legacyCheck ? 1 : 0); // legacy v2 compatibility
            Shader.SetGlobalFloat("_UdonLightVolumeCount", 1);
            Shader.SetGlobalFloat("_UdonLightVolumeAdditiveCount", 0);
            Shader.SetGlobalFloat("_UdonLightVolumeProbesBlend", 1);
            var matrices = new Matrix4x4[32]; matrices[0] = Matrix4x4.identity;
            Shader.SetGlobalMatrixArray("_UdonLightVolumeInvWorldMatrix", matrices);
            var edge = new Vector4[32]; edge[0] = new Vector4(100, 100, 100, 0);
            Shader.SetGlobalVectorArray("_UdonLightVolumeInvLocalEdgeSmooth", edge);
            var tint = new Vector4[32]; tint[0] = new Vector4(.5f, .8f, 1, 1);
            Shader.SetGlobalVectorArray("_UdonLightVolumeColor", tint);
            var rotation = new Vector4[64]; rotation[0] = new Vector4(0, 1, 0, 0); rotation[1] = new Vector4(-1, 0, 0, 0);
            Shader.SetGlobalVectorArray("_UdonLightVolumeRotation", rotation);
            var uvw = new Vector4[96];
            for (int k = 0; k < 3; k++) uvw[k] = nativeCheck
                ? new Vector4((k * nx + 1f) / (nx * 3), 1f/ny, 1f/nz,
                    k == 0 ? (nx-2f)/(nx*3) : k == 1 ? (ny-2f)/ny : (nz-2f)/nz)
                : new Vector4((k * n + .5f) / (n * 3), .5f/n, .5f/n, k == 0 ? (n-1f)/(n*3) : (n-1f)/n);
            Shader.SetGlobalVectorArray("_UdonLightVolumeUvwScale", uvw);
            if (legacyCheck) {
                var legacy = new Vector4[192];
                var scale = new Vector4(uvw[0].w, uvw[1].w, uvw[2].w, 0);
                for (int k=0;k<3;k++) {
                    legacy[k*2]=new Vector4(uvw[k].x,uvw[k].y,uvw[k].z,0);
                    legacy[k*2+1]=legacy[k*2]+scale;
                }
                Shader.SetGlobalVectorArray("_UdonLightVolumeUvw",legacy);
                // Leave newer UV globals zero: a mistaken v2 lookup must fail the fixture.
                Shader.SetGlobalVectorArray("_UdonLightVolumeUvwScale",new Vector4[96]);
            }
        }
        Physics.SyncTransforms();
        var diagnostics = new StringBuilder();
        // FastFur's editor GUI sets these to -1 outside VRChat; in VRChat's eye pass they are 0.
        diagnostics.AppendLine($"globals before: mirror {Shader.GetGlobalFloat("_VRChatMirrorMode")}, camera {Shader.GetGlobalFloat("_VRChatCameraMode")}");
        Shader.SetGlobalFloat("_VRChatMirrorMode", 0);
        Shader.SetGlobalFloat("_VRChatCameraMode", 0);
        diagnostics.AppendLine($"quad mesh: {(quad.GetComponent<MeshFilter>().sharedMesh != null ? quad.GetComponent<MeshFilter>().sharedMesh.name : "null")}");
        diagnostics.AppendLine($"shader supported: {shader.isSupported}, passes: {shader.passCount}, material shader: {material.shader.name}");
        diagnostics.AppendLine($"renderer bounds: {renderer.bounds}, camera: {cam.transform.position} fwd {cam.transform.forward}");
        // Diagnostic renders: the quad unlit red (is it drawn at all?), the exporter ungated.
        var red = new Material(Shader.Find("Unlit/Color"));
        red.color = Color.red;
        renderer.sharedMaterial = red;
        cam.Render();
        SavePng(rt, Path.Combine(outDir, "diag-unlit.png"));
        renderer.sharedMaterial = material;
        material.SetFloat("_GateRadius", 1e6f);
        cam.Render();
        SavePng(rt, Path.Combine(outDir, "diag-nogate.png"));
        material.SetFloat("_GateRadius", 1);
        if (depthCam != null)
        {
            depthCam.Render();
            diagnostics.AppendLine($"depth camera: {depthCam.transform.position} fwd {depthCam.transform.forward}, fov {depthCam.fieldOfView}, aspect {depthCam.aspect}");
        }
        File.WriteAllText(Path.Combine(outDir, "diagnostics.txt"), diagnostics.ToString());
        cam.Render();

        RenderTexture.active = rt;
        var tex = new Texture2D(Size, Size, TextureFormat.RGBA32, false, false);
        tex.ReadPixels(new Rect(0, 0, Size, Size), 0, 0, false);
        tex.Apply();
        RenderTexture.active = null;
        var pixels = tex.GetPixels32();   // bottom row first
        var raw = new byte[Size * Size * 4];
        for (int y = 0; y < Size; y++)
        {
            for (int x = 0; x < Size; x++)
            {
                var p = pixels[(Size - 1 - y) * Size + x];
                int o = (y * Size + x) * 4;
                raw[o] = p.r; raw[o + 1] = p.g; raw[o + 2] = p.b; raw[o + 3] = p.a;
            }
        }
        File.WriteAllBytes(Path.Combine(outDir, "frame.rgba"), raw);
        File.WriteAllBytes(Path.Combine(outDir, "frame.png"), tex.EncodeToPNG());

        // Ground truth: eye depth at each sample centre, top-down, by raycast.
        var truthCam = depthCam != null ? depthCam : cam;
        var expected = new float[DepthW * DepthH];
        for (int sy = 0; sy < DepthH; sy++)
        {
            for (int sx = 0; sx < DepthW; sx++)
            {
                var viewport = new Vector3((sx + 0.5f) / DepthW, 1 - (sy + 0.5f) / DepthH, 0);
                if (depthCam != null)
                {
                    // The exporter reads the texel under the sample centre: cast through its centre.
                    int w = depthCam.targetTexture.width, h = depthCam.targetTexture.height;
                    float tx = Mathf.Min(Mathf.Floor((sx + 0.5f) / DepthW * w), w - 1);
                    float ty = Mathf.Min(Mathf.Floor((sy + 0.5f) / DepthH * h), h - 1);
                    viewport = new Vector3((tx + 0.5f) / w, 1 - (ty + 0.5f) / h, 0);
                }
                var ray = truthCam.ViewportPointToRay(viewport);
                // The ray starts on the near plane, so measure eye depth from the camera itself.
                expected[sy * DepthW + sx] = Physics.Raycast(ray, out var hit, 1000)
                    ? Vector3.Dot(hit.point - truthCam.transform.position, truthCam.transform.forward)
                    : 0;
            }
        }
        var json = new StringBuilder();
        json.Append("{\n");
        json.Append($"  \"width\": {Size}, \"height\": {Size},\n");
        json.Append($"  \"graphicsDevice\": \"{SystemInfo.graphicsDeviceType}\",\n");
        json.Append($"  \"cameraToWorld\": [{Floats(truthCam.cameraToWorldMatrix)}],\n");
        // The anchor: the camera's transform (the quad shares its rotation, 0.25 m ahead).
        json.Append($"  \"anchorToWorld\": [{Floats(cam.transform.localToWorldMatrix)}],\n");
        json.Append($"  \"projection\": [{Floats(depthCam != null ? depthCam.projectionMatrix : GL.GetGPUProjectionMatrix(cam.projectionMatrix, true))}],\n");
        json.Append($"  \"near\": {F(truthCam.nearClipPlane)}, \"far\": {F(truthCam.farClipPlane)},\n");
        json.Append($"  \"depthWidth\": {DepthW}, \"depthHeight\": {DepthH},\n");
        json.Append($"  \"expectedDepth\": [{string.Join(",", expected.Select(F))}]\n");
        json.Append("}\n");
        File.WriteAllText(Path.Combine(outDir, "truth.json"), json.ToString());
    }

    static void SavePng(RenderTexture rt, string path)
    {
        RenderTexture.active = rt;
        var t = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false, false);
        t.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
        t.Apply();
        RenderTexture.active = null;
        File.WriteAllBytes(path, t.EncodeToPNG());
    }

    static void Primitive(PrimitiveType type, Vector3 position, Vector3 scale)
    {
        var go = GameObject.CreatePrimitive(type);
        go.transform.position = position;
        go.transform.localScale = scale;
    }

    static string F(float v) => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);

    /// Row-major, all 16 values.
    static string Floats(Matrix4x4 m) =>
        string.Join(",", Enumerable.Range(0, 16).Select(k => F(m[k / 4, k % 4])));
}
