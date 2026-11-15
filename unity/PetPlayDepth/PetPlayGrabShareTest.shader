// Experiment: does a named GrabPass taken in the headset's eye pass reach VRChat's camera pass?
// If it does, the exporter could take the eye's own depth (encoded into the eye image, grabbed,
// then covered) into the Stream camera feed without a second scene render.
// Plan: petplay markdown/vrchat-depth/README.md ("GrabPass between passes").
//
// 1. Mark (eye pass only): a magenta/green checker in the top-left corner of each eye, where the
//    hidden-area mask usually keeps it out of the wearer's sight.
// 2. GrabPass "_PPDShareTex" (every camera that draws this object).
// 3. Show (VRChat camera pass only): three 256 px patches at the bottom-right of the camera image:
//    yellow reference; the whole grab read as a texture array (eye grabs are arrays under
//    single-pass instanced stereo); the whole grab read as a 2D texture. A checker in a grab patch
//    means the eye's grab reached the camera; the camera's own scene there means each camera
//    grabs for itself.
Shader "PetPlay/GrabShareTest"
{
    Properties { }
    SubShader
    {
        Tags { "Queue"="Overlay+400" "RenderType"="Overlay" "IgnoreProjector"="True" "DisableBatching"="True" "VRCFallback"="Hidden" }
        ZTest Always
        ZWrite Off
        Cull Off
        Blend Off

        // Shared by every pass. Show patches: 0 yellow, 1 array read, 2 2D read; one pass each so
        // each can declare the shared texture its own way.
        CGINCLUDE
        #include "UnityCG.cginc"
        float _VRChatMirrorMode, _VRChatCameraMode;
        struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID };
        struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; UNITY_VERTEX_OUTPUT_STEREO };
        v2f PatchVert(appdata v, float patch)
        {
            v2f o;
            UNITY_SETUP_INSTANCE_ID(v);
            UNITY_INITIALIZE_OUTPUT(v2f, o);
            UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
            o.uv = v.uv;
            if (_VRChatMirrorMode != 0 || _VRChatCameraMode == 0) { o.pos = float4(0, 0, -2, 1); return o; }
            // Top-down image pixels, bottom-right: patches 2, 1, 0 from the right edge.
            float2 hi = _ScreenParams.xy - 16 - float2((2 - patch) * 272, 0);
            float2 imagePx = lerp(hi - 256, hi, v.uv);
            float row = _ProjectionParams.x < 0 ? _ScreenParams.y - imagePx.y : imagePx.y;
            float2 ndc = float2(imagePx.x / _ScreenParams.x * 2 - 1, 1 - row / _ScreenParams.y * 2);
            #if !UNITY_UV_STARTS_AT_TOP
                ndc.y = -ndc.y;
            #endif
            o.pos = float4(ndc, UNITY_NEAR_CLIP_VALUE > 0 ? 0.5 : 0.0, 1);
            return o;
        }
        ENDCG

        Pass
        {
            Name "Mark"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #pragma multi_compile_instancing
            v2f vert(appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_OUTPUT(v2f, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                o.uv = v.uv;
                if (_VRChatMirrorMode != 0 || _VRChatCameraMode != 0) { o.pos = float4(0, 0, -2, 1); return o; }
                // Image uv 0.02..0.10 from the top-left, in clip space.
                float2 image = lerp(0.02, 0.10, v.uv);
                float row = _ProjectionParams.x < 0 ? 1 - image.y : image.y;
                float2 ndc = float2(image.x * 2 - 1, 1 - row * 2);
                #if !UNITY_UV_STARTS_AT_TOP
                    ndc.y = -ndc.y;
                #endif
                o.pos = float4(ndc, UNITY_NEAR_CLIP_VALUE > 0 ? 0.5 : 0.0, 1);
                return o;
            }
            float4 frag(v2f i) : SV_Target
            {
                uint2 c = (uint2)floor(i.uv * 8);
                return ((c.x + c.y) & 1u) ? float4(0, 1, 0, 1) : float4(1, 0, 1, 1);
            }
            ENDCG
        }

        GrabPass { "_PPDShareTex" }


        Pass
        {
            Name "Reference"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #pragma multi_compile_instancing
            v2f vert(appdata v) { return PatchVert(v, 0); }
            float4 frag(v2f i) : SV_Target { return float4(1, 1, 0, 1); }
            ENDCG
        }

        Pass
        {
            Name "ShowArray"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #pragma multi_compile_instancing
            Texture2DArray _PPDShareTex;
            SamplerState sampler_linear_clamp;
            v2f vert(appdata v) { return PatchVert(v, 1); }
            float4 frag(v2f i) : SV_Target
            {
                return float4(_PPDShareTex.SampleLevel(sampler_linear_clamp, float3(i.uv.x, 1 - i.uv.y, 0), 0).rgb, 1);
            }
            ENDCG
        }

        Pass
        {
            Name "Show2D"
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 5.0
            #pragma multi_compile_instancing
            Texture2D _PPDShareTex;
            SamplerState sampler_linear_clamp;
            v2f vert(appdata v) { return PatchVert(v, 2); }
            float4 frag(v2f i) : SV_Target
            {
                return float4(_PPDShareTex.SampleLevel(sampler_linear_clamp, float2(i.uv.x, 1 - i.uv.y), 0).rgb, 1);
            }
            ENDCG
        }
    }
}
