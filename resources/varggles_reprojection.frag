#version 450

layout (location = 0) in vec2 uv; 
layout (binding = 0) uniform sampler2D eyeLeft;
layout (binding = 1) uniform sampler2D eyeRight;

uniform mat4 renderPose;     
uniform mat4 currentPose;    
uniform float halfFOVInRadians;

layout (location = 0) out vec4 outColor;

const float PI = 3.141592;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

// Dampening factor to control reprojection strength
const float REPROJECTION_STRENGTH = 1.0; // Keep at 1.0 to test full corrected effect

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

    // Base lookup direction based on output UV (conceptually in CurrentHMD space)
    vec3 cubeMapLookupDirection = vec3(
        sin(xy_angles.x) * cos(xy_eye_angles.y), 
        sin(xy_eye_angles.y),                     
        cos(xy_angles.x) * cos(xy_eye_angles.y)  
    );

    // --- REPROJECTION LOGIC --- 
    // Standard Lookup Direction (no reprojection adjustment)
    vec3 standardLookupDirection = cubeMapLookupDirection;

    // Reprojected Lookup Direction
    // Calculate relative rotation: CurrentHMD -> RenderHMD
    // inverse(renderPose) transforms RenderHMD -> World
    // currentPose transforms World -> CurrentHMD
    // So inverse(renderPose) * currentPose transforms CurrentHMD -> RenderHMD
    mat4 relativeRotation = inverse(renderPose) * currentPose; 
    // Apply to find equivalent direction in RenderHMD space
    vec3 reprojectedLookupDirection = (relativeRotation * vec4(cubeMapLookupDirection, 0.0)).xyz;

    // Blend the lookup directions based on strength
    vec3 finalLookupDirection = mix(standardLookupDirection, reprojectedLookupDirection, REPROJECTION_STRENGTH);
    // --- END REPROJECTION LOGIC ---
    
    // Apply the standard renderPose transformation (like in varggles.frag) to the final lookup direction
    vec3 renderHmdDirection = (renderPose * vec4(finalLookupDirection, 0.0)).xyz;

    // Project the final direction
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