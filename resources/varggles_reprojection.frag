#version 450

layout (location = 0) in vec2 uv; 
layout (binding = 0) uniform sampler2D eyeLeft;
layout (binding = 1) uniform sampler2D eyeRight;

uniform mat4 renderPose;     
uniform mat4 currentPose;    
uniform float halfFOVInRadians;

const float warpFactor = 0.6;

layout (location = 0) out vec4 outColor;

const float PI = 3.141592;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

//#define USE_ORIENTATION_ONLY

void main() {
    vec2 xy_flipped = vec2(uv.x, 1.0 - uv.y);
    vec2 xy_normalized = 2.0 * xy_flipped - 1.0;
    vec2 xy_angles = xy_normalized * vec2(PI, HALF_PI);

    vec2 xy_eye_angles = xy_angles; 
    xy_eye_angles.y *= 2.0; 

    bool renderTopHalf = xy_eye_angles.y >= 0.0; 
    if (renderTopHalf) {
        xy_eye_angles.y -= HALF_PI; 
    } else {
        xy_eye_angles.y += HALF_PI; 
    }

    float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI); 

    // Base direction from spherical angles (as if there's no re-projection)
    vec3 originalDirection = vec3(
        sin(xy_angles.x) * cos(xy_eye_angles.y),
        sin(xy_eye_angles.y),
        cos(xy_angles.x) * cos(xy_eye_angles.y)
    );

    mat4 relativeMatrix = inverse(renderPose) * currentPose;

    // Transform the original direction into the "old render" space
    // to see how it should be oriented now
    vec3 reprojectedDirection = (relativeMatrix * vec4(originalDirection, 0.0)).xyz;

    // Blend between no warp (0) and full warp (1)
    vec3 finalDirection = mix(originalDirection, reprojectedDirection, warpFactor);

    //---------------------------------------
    // Re-apply the original pose
    //---------------------------------------
    vec3 renderHmdDirection = (renderPose * vec4(finalDirection, 0.0)).xyz;

    // If the direction is behind the camera, you can discard (optional)
    if (renderHmdDirection.z >= 0.0) {
       discard;
    }

    //---------------------------------------
    // Project to 2D
    //---------------------------------------
    float projX = (renderHmdDirection.x / abs(renderHmdDirection.z)) / fovScalar;
    float projY = (renderHmdDirection.y / abs(renderHmdDirection.z)) / fovScalar;

    vec2 eyeUV = vec2(
        (projX + 1.0) / 2.0,
        (projY + 1.0) / 2.0
    );

    eyeUV = clamp(eyeUV, 0.0, 1.0);

    if (renderTopHalf) { 
        outColor = texture(eyeLeft, eyeUV); 
    } else { 
        outColor = texture(eyeRight, eyeUV); 
    }
}