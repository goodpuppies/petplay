// Writes this eye's depth and camera pose into the eye image as a PetPlay depth block, for the
// wearer only. Plan: petplay markdown/vrchat-depth/README.md; format: PetPlayDepthFormat.cginc.
//
// Put it on a quad that follows the head through a constraint, about 0.25 m in front of the face,
// not parented to the head bone (VRChat shrinks that locally). The quad's own position only keeps
// it from being culled: the vertex shader places the block in screen space. The avatar also needs
// a directional light with shadows for _CameraDepthTexture to exist (SPS lights don't count).
Shader "PetPlay/DepthExporter"
{
    Properties
    {
        [Header(Block)]
        _OriginX ("Grid left, eye pixels from the left", Float) = 960
        _OriginY ("Grid top, eye pixels from the top", Float) = 960
        _CellPx ("Pixels per cell", Float) = 2
        _GridWidth ("Grid width in cells (>= 64)", Float) = 128
        _BitsR ("Bits in red", Range(1, 8)) = 6
        _BitsG ("Bits in green", Range(1, 8)) = 6
        _BitsB ("Bits in blue", Range(1, 8)) = 6
        [ToggleUI] _Calibration3D ("3D colour calibration (worlds that grade colours)", Float) = 0
        _LevelInset ("Level inset: levels span inset..255-2*inset", Range(0, 64)) = 0
        [Header(Depth)]
        _DepthWidth ("Depth samples across", Float) = 64
        _DepthHeight ("Depth samples down", Float) = 64
        _DepthRef ("Log depth near, m", Float) = 0.05
        _DepthFar ("Log depth far, m", Float) = 1000
        [Header(Depth camera)]
        _Source ("Depth from (0 this pass's depth texture, 1 the avatar's depth camera)", Range(0, 1)) = 0
        _DepthCamTex ("Depth camera target (a Depth-format render texture)", 2D) = "black" {}
        _DepthCamNear ("Depth camera near plane, m", Float) = 0.05
        _DepthCamFar ("Depth camera far plane, m", Float) = 500
        _DepthCamTanHalfY ("Depth camera tan(vertical FOV / 2)", Float) = 1.428
        _DepthCamAspect ("Depth camera aspect, width / height", Float) = 1.25
        [Header(Gating)]
        _Target ("Draw into (0 the eye, 1 VRChat's camera)", Range(0, 1)) = 0
        _Eye ("Eye to write (0 left, 1 right)", Float) = 0
        _GateRadius ("Only for cameras this close to the quad's anchor, m", Float) = 0.5
        _AnchorOffset ("Anchor in object space (the head, behind the quad)", Vector) = (0, 0, -0.25, 0)
        [ToggleUI] _FlipImageY ("Debug: invert the image-row convention", Float) = 0
        [ToggleUI] _AllowMono ("Debug: also draw in non-stereo cameras (editor tests)", Float) = 0
    }
    SubShader
    {
        // Late in Overlay, after everything that writes depth or colour we care about. No
        // ShadowCaster pass and no Fallback: the block must not reach the depth texture.
        Tags { "Queue"="Overlay+500" "RenderType"="Overlay" "IgnoreProjector"="True" "DisableBatching"="True" "VRCFallback"="Hidden" }
        Pass
        {
            // ForwardBase so Unity fills the main light, the four vertex lights and the probe SH
            // for this renderer: the block's lighting record (format.ts LIGHTING).
            Tags { "LightMode"="ForwardBase" }
            ZTest Always
            ZWrite Off
            Cull Off
            Blend Off
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #pragma multi_compile_instancing
            #pragma multi_compile_fwdbase
            #pragma shader_feature_local _ PPD_LV_CHECK_FINE
            #include "UnityCG.cginc"
            #include "UnityLightingCommon.cginc"
            #include "PetPlayDepthFormat.cginc"

            float _OriginX, _OriginY, _CellPx, _GridWidth, _BitsR, _BitsG, _BitsB, _Calibration3D, _LevelInset;
            float _DepthWidth, _DepthHeight, _DepthRef, _DepthFar, _Eye, _GateRadius, _FlipImageY, _AllowMono, _Target;
            float4 _AnchorOffset;
            float _Source, _DepthCamNear, _DepthCamFar, _DepthCamTanHalfY, _DepthCamAspect;
            // The depth camera sits at the anchor with the exporter's rotation (the builder's
            // "Depth Camera"), so its pose is the header's anchor frame.
            Texture2D<float> _DepthCamTex;
            SamplerState sampler_point_clamp;
            float4 _DepthCamTex_TexelSize;
            float _VRChatMirrorMode;
            float _VRChatCameraMode;
            UNITY_DECLARE_DEPTH_TEXTURE(_CameraDepthTexture);
            // VRC Light Volumes (red.sim.lightvolumes 3.x) globals, set by the world's Udon
            // manager; zero in worlds without it. Plain globals on D3D11.
            float _UdonLightVolumeEnabled, _UdonLightVolumeVersion, _UdonLightVolumeCount;
            float _UdonLightVolumeAdditiveCount, _UdonLightVolumeProbesBlend;
            float _UdonLightVolumeSharpBounds, _UdonPointLightVolumeCount, _UdonLightBrightnessCutoff;
            #include "PetPlayLightVolumes.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            PPDLayout Layout()
            {
                // Animated from 0..1 avatar parameters, so values arrive fractional: round them.
                uint3 bits = (uint3)clamp(round(float3(_BitsR, _BitsG, _BitsB)), 1, 8);
                uint2 depthSize = (uint2)max(round(float2(_DepthWidth, _DepthHeight)), 1);
                return PPDDeriveLayout(bits, (uint)max(round(_GridWidth), 64), depthSize.x, depthSize.y,
                    _Calibration3D > 0.5 ? 1u : 0u, (uint)clamp(round(_LevelInset), 0, 64));
            }

            uint EyeIndex()
            {
                #if defined(USING_STEREO_MATRICES)
                    return unity_StereoEyeIndex;
                #else
                    return 0u;
                #endif
            }

            // Render target rows run bottom-up when Unity flips the projection to render into a
            // texture (cnlohr's SwadgeAppDataExporter uses the same rule).
            bool RowsFlipped() { return (_ProjectionParams.x < 0) != (_FlipImageY > 0.5); }
            float CellPx() { return max(round(_CellPx), 1); }
            float2 Origin() { return round(float2(_OriginX, _OriginY)); }

            bool ShouldDraw()
            {
                if (_VRChatMirrorMode != 0) return false;
                // Never inside the depth camera's own render (it would read its own target).
                if (_Source > 0.5 && all(abs(_ScreenParams.xy - _DepthCamTex_TexelSize.zw) < 0.5)) return false;
                bool cameraPass = _VRChatCameraMode != 0;
                if (_Target > 0.5)
                {
                    // Camera target: only VRChat's handheld camera, whose Stream mode is what the
                    // desktop window then shows. The headset view stays clean. Remote copies of
                    // the avatar never get here: the exporter is enabled only when IsLocal.
                    return cameraPass;
                }
                if (cameraPass) return false;
                #if !defined(USING_STEREO_MATRICES)
                    if (_AllowMono < 0.5) return false;   // the eye pass only
                #else
                    if (unity_StereoEyeIndex != (uint)round(_Eye)) return false;
                #endif
                float3 anchor = mul(unity_ObjectToWorld, float4(_AnchorOffset.xyz, 1)).xyz;
                return distance(_WorldSpaceCameraPos, anchor) < _GateRadius;
            }

            v2f vert(appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_OUTPUT(v2f, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                if (!ShouldDraw())
                {
                    o.pos = float4(0, 0, -2, 1);   // outside the clip volume: drawn nowhere
                    return o;
                }
                PPDLayout l = Layout();
                float cell = CellPx();
                float q = PPD_QUIET_CELLS * cell;
                float2 lo = Origin() - q;
                float2 hi = Origin() + float2(l.gridWidth, l.gridHeight) * cell + q;
                float2 imagePx = lerp(lo, hi, v.uv);   // top-down image pixels
                float row = RowsFlipped() ? _ScreenParams.y - imagePx.y : imagePx.y;
                float2 ndc = float2(imagePx.x / _ScreenParams.x * 2 - 1, 1 - row / _ScreenParams.y * 2);
                #if !UNITY_UV_STARTS_AT_TOP
                    ndc.y = -ndc.y;
                #endif
                o.pos = float4(ndc, UNITY_NEAR_CLIP_VALUE > 0 ? 0.5 : 0.0, 1);
                return o;
            }

            // --- depth source -------------------------------------------------------------

            bool UseDepthCamera() { return _Source > 0.5; }

            // The avatar's depth camera: its whole target, top-down, at the centre of the texel
            // under each sample centre (at most half a texel off it; a sample on a texel edge
            // would otherwise take either neighbour). Camera targets sample with v = 0 at the
            // bottom of the rendered image on every API (Unity flips the render).
            uint DepthCameraSample(PPDLayout l, PPDFrame f, uint sx, uint sy)
            {
                float2 size = _DepthCamTex_TexelSize.zw;
                float2 texel = min(floor((float2(sx, sy) + 0.5) / float2(l.depthWidth, l.depthHeight) * size), size - 1);
                float2 uv = float2((texel.x + 0.5) / size.x, 1 - (texel.y + 0.5) / size.y);
                float raw = _DepthCamTex.SampleLevel(sampler_point_clamp, uv, 0);
                float n = _DepthCamNear, fa = _DepthCamFar;
                #if defined(UNITY_REVERSED_Z)
                    bool cleared = raw <= 1e-7;
                    float metres = fa / ((fa / n - 1) * raw + 1);
                #else
                    bool cleared = raw >= 1 - 1e-7;
                    float metres = n * fa / (fa - raw * (fa - n));
                #endif
                if (cleared || metres >= fa * 0.9999) return 0u;
                return PPDQuantizeDepth(metres, f.depthRef, f.depthFar, l.bitsPerCell);
            }

            uint PPDDepthSample(PPDLayout l, PPDFrame f, uint index)
            {
                uint sx = index % l.depthWidth;
                uint sy = index / l.depthWidth;
                if (UseDepthCamera()) return DepthCameraSample(l, f, sx, sy);
                // Sample centres over the whole eye image, top-down, then into target rows. The
                // depth texture shares the eye target's pixel grid, so rows map one to one.
                float2 imagePx = (float2(sx, sy) + 0.5) / float2(l.depthWidth, l.depthHeight) * _ScreenParams.xy;
                float row = RowsFlipped() ? _ScreenParams.y - imagePx.y : imagePx.y;
                float2 uv = float2(imagePx.x, row) / _ScreenParams.xy;
                #if defined(UNITY_SINGLE_PASS_STEREO)
                    // Double-wide: one texture holds both eyes side by side.
                    uv = UnityStereoTransformScreenSpaceTex(uv);
                #endif
                float raw = SAMPLE_DEPTH_TEXTURE_LOD(_CameraDepthTexture, float4(uv, 0, 0));
                #if defined(UNITY_REVERSED_Z)
                    bool cleared = raw <= 1e-7;
                #else
                    bool cleared = raw >= 1 - 1e-7;
                #endif
                float metres = LinearEyeDepth(raw);
                if (cleared || metres >= _ProjectionParams.z * 0.9999) return 0u;
                return PPDQuantizeDepth(metres, f.depthRef, f.depthFar, l.bitsPerCell);
            }

            // --- lighting record (format.ts LIGHTING) ----------------------------------------

            float4 LightingVector(uint g)
            {
                // Groups of four floats from record offset 27.
                if (g == 0u) return _WorldSpaceLightPos0;
                if (g == 1u) return _LightColor0;
                if (g == 2u) return unity_4LightPosX0;
                if (g == 3u) return unity_4LightPosY0;
                if (g == 4u) return unity_4LightPosZ0;
                if (g == 5u) return unity_4LightAtten0;
                if (g < 10u) return unity_LightColor[g - 6u];
                if (g == 10u) return unity_AmbientSky;
                if (g == 11u) return unity_AmbientEquator;
                if (g == 12u) return unity_AmbientGround;
                if (g == 13u) return unity_FogColor;
                if (g == 14u) return unity_FogParams;
                if (g == 15u) return unity_SpecCube0_HDR;
                if (g == 16u) return unity_SpecCube0_BoxMax;
                if (g == 17u) return unity_SpecCube0_BoxMin;
                if (g == 18u) return unity_SpecCube0_ProbePosition;
                if (g == 19u) return unity_SpecCube1_HDR;
                if (g == 20u) return unity_SpecCube1_BoxMax;
                if (g == 21u) return unity_SpecCube1_BoxMin;
                if (g == 22u) return unity_SpecCube1_ProbePosition;
                if (g == 23u) return float4(_UdonLightVolumeEnabled, _UdonLightVolumeVersion, _UdonLightVolumeCount, _UdonLightVolumeAdditiveCount);
                if (g == 24u) return float4(_UdonLightVolumeProbesBlend, _UdonLightVolumeSharpBounds, _UdonPointLightVolumeCount, _UdonLightBrightnessCutoff);
                return 0;
            }

            float PPDLightingFloat(uint i)
            {
                if (i < 24u)
                {
                    uint g = i / 4u;
                    float4 v = g == 0u ? unity_SHAr : g == 1u ? unity_SHAg : g == 2u ? unity_SHAb
                        : g == 3u ? unity_SHBr : g == 4u ? unity_SHBg : unity_SHBb;
                    return v[i % 4u];
                }
                if (i < 27u) return unity_SHC[i - 24u];
                if (i < 127u) return LightingVector((i - 27u) / 4u)[(i - 27u) % 4u];
                if (i < 130u) return unity_ObjectToWorld[i - 127u][3];
                return PPDLVFloat(i - 130u);
            }

            PPDFrame Frame()
            {
                PPDFrame f;
                f.timeTag = asuint(_Time.y);
                f.eye = EyeIndex();
                f.flags = 0u;
                if (_ProjectionParams.x < 0) f.flags |= PPD_FLAG_PROJECTION_FLIPPED;
                #if defined(UNITY_REVERSED_Z)
                    f.flags |= PPD_FLAG_REVERSED_Z;
                #endif
                #if defined(UNITY_STEREO_INSTANCING_ENABLED)
                    f.flags |= PPD_FLAG_STEREO_INSTANCED;
                #endif
                #if defined(UNITY_SINGLE_PASS_STEREO)
                    f.flags |= PPD_FLAG_SINGLE_PASS_DOUBLE_WIDE;
                #endif
                if (_VRChatCameraMode != 0) f.flags |= PPD_FLAG_VRCHAT_CAMERA;
                f.viewToWorld = UNITY_MATRIX_I_V;
                f.projection = float4(UNITY_MATRIX_P[0][0], UNITY_MATRIX_P[1][1], UNITY_MATRIX_P[0][2], UNITY_MATRIX_P[1][2]);
                f.nearPlane = _ProjectionParams.y;
                f.farPlane = _ProjectionParams.z;
                f.screenSize = _ScreenParams.xy;
                f.depthRef = _DepthRef;
                f.depthFar = _DepthFar;
                // The head anchor: the exporter's own frame (it rides a head constraint) with the
                // scale removed and the origin moved back to the head. Same in every pass, so the
                // camera pass tells PetPlay where the wearer's head is in VRChat's world.
                float3x3 m = (float3x3)unity_ObjectToWorld;
                float3 c0 = normalize(float3(m[0][0], m[1][0], m[2][0]));
                float3 c1 = normalize(float3(m[0][1], m[1][1], m[2][1]));
                float3 c2 = normalize(float3(m[0][2], m[1][2], m[2][2]));
                float3 anchor = mul(unity_ObjectToWorld, float4(_AnchorOffset.xyz, 1)).xyz;
                f.anchorToWorld = float4x4(
                    c0.x, c1.x, c2.x, anchor.x,
                    c0.y, c1.y, c2.y, anchor.y,
                    c0.z, c1.z, c2.z, anchor.z,
                    0, 0, 0, 1);
                if (UseDepthCamera())
                {
                    // The depth camera's view: the anchor frame looking down its +z, as a view
                    // matrix looks down -z; a symmetric projection, rows top-down (unflipped).
                    f.flags = (f.flags & ~PPD_FLAG_PROJECTION_FLIPPED) | PPD_FLAG_DEPTH_CAMERA;
                    f.viewToWorld = float4x4(
                        c0.x, c1.x, -c2.x, anchor.x,
                        c0.y, c1.y, -c2.y, anchor.y,
                        c0.z, c1.z, -c2.z, anchor.z,
                        0, 0, 0, 1);
                    float t = max(_DepthCamTanHalfY, 1e-4);
                    f.projection = float4(1 / (t * max(_DepthCamAspect, 1e-4)), 1 / t, 0, 0);
                    f.nearPlane = _DepthCamNear;
                    f.farPlane = _DepthCamFar;
                }
                return f;
            }

            float4 frag(v2f i) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(i);
                float row = i.pos.y;   // pixel centre, target rows
                float imageY = RowsFlipped() ? _ScreenParams.y - row : row;
                float2 origin = Origin();
                float x = i.pos.x;
                #if defined(UNITY_SINGLE_PASS_STEREO)
                    // Double-wide: the right eye's pixels start one eye width in.
                    x -= unity_StereoEyeIndex * _ScreenParams.x;
                #endif
                int cx = (int)floor((x - origin.x) / CellPx());
                int cy = (int)floor((imageY - origin.y) / CellPx());
                return float4(PPDCellColor(Layout(), Frame(), cx, cy), 1);
            }
            ENDCG
        }
    }
}
