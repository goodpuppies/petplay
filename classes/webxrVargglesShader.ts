const VARGGLES_FRAGMENT_LOGIC = `
const float PI = 3.141592653589793;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

vec4 sampleVargglesPanorama(vec2 baseUv, sampler2D eyeLeft, sampler2D eyeRight, mat4 lookRotation, float halfFOVInRadians) {
    vec2 xy = vec2(baseUv.x, 1.0 - baseUv.y);
    vec2 angles = (2.0 * xy - vec2(1.0, 1.0)) * vec2(PI, HALF_PI);
    angles.y *= 2.0;

    bool renderTopHalf = angles.y >= 0.0;
    if (renderTopHalf) {
        angles.y -= HALF_PI;
    } else {
        angles.y += HALF_PI;
    }

    float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI);
    vec3 lookupDirection = vec3(sin(angles.x), 1.0, cos(angles.x)) *
        vec3(cos(angles.y), sin(angles.y), cos(angles.y));
    lookupDirection = (lookRotation * vec4(lookupDirection, 0.0)).xyz;

    float u = (((lookupDirection.x / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5;
    float v = 1.0 - ((((lookupDirection.y / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5);
    vec2 eyeUv = clamp(vec2(u, v), 0.0, 1.0);

    return renderTopHalf ? texture(eyeLeft, eyeUv) : texture(eyeRight, eyeUv);
}
`;

export const WEBXR_VARGGLES_GLSL450_FRAGMENT = `#version 450
layout (location = 0) in vec2 uv;
layout (binding = 0) uniform sampler2D eyeLeft;
layout (binding = 1) uniform sampler2D eyeRight;
uniform mat4 lookRotation;
uniform float halfFOVInRadians;
layout (location = 0) out vec4 outColor;

${VARGGLES_FRAGMENT_LOGIC}

void main() {
    outColor = sampleVargglesPanorama(uv, eyeLeft, eyeRight, lookRotation, halfFOVInRadians);
}
`;

export const WEBXR_VARGGLES_GLSL330_FRAGMENT = `#version 330
in vec2 fragTexCoord;
in vec4 fragColor;
uniform sampler2D texture0;
uniform vec2 outputUvScale;
uniform vec2 outputUvOffset;
uniform mat4 lookRotation;
uniform float halfFOVInRadians;
out vec4 finalColor;

const float PI = 3.141592653589793;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

void main() {
    vec2 outputUv = fragTexCoord * outputUvScale + outputUvOffset;
    vec2 xy = vec2(outputUv.x, 1.0 - outputUv.y);
    vec2 angles = (2.0 * xy - vec2(1.0, 1.0)) * vec2(PI, HALF_PI);
    angles.y *= 2.0;

    bool renderTopHalf = angles.y >= 0.0;
    if (renderTopHalf) {
        angles.y -= HALF_PI;
    } else {
        angles.y += HALF_PI;
    }

    float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI);
    vec3 lookupDirection = vec3(sin(angles.x), 1.0, cos(angles.x)) *
        vec3(cos(angles.y), sin(angles.y), cos(angles.y));
    lookupDirection = (lookRotation * vec4(lookupDirection, 0.0)).xyz;

    float u = (((lookupDirection.x / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5;
    float v = 1.0 - ((((lookupDirection.y / abs(lookupDirection.z)) / fovScalar) + 1.0) * 0.5);
    vec2 eyeUv = clamp(vec2(u, v), 0.0, 1.0);

    finalColor = texture(texture0, eyeUv) * fragColor;
}
`;
