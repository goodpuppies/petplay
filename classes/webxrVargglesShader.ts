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
// 0: existing bilinear sampling; 1: Catmull-Rom reconstruction of the same eye image.
uniform int panoramaFilter;
out vec4 finalColor;

const float PI = 3.141592653589793;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

vec4 sampleEye(vec2 eyeUv) {
    if (panoramaFilter == 0) return texture(texture0, eyeUv);

    vec2 size = vec2(textureSize(texture0, 0));
    vec2 pixel = eyeUv * size;
    vec2 center = floor(pixel - 0.5) + 0.5;
    vec2 f = pixel - center;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = -0.5 * f + f2 - 0.5 * f3;
    vec2 w1 = vec2(1.0) - 2.5 * f2 + 1.5 * f3;
    vec2 w2 = 0.5 * f + 2.0 * f2 - 1.5 * f3;
    vec2 w3 = -0.5 * f2 + 0.5 * f3;
    vec2 middle = w1 + w2;
    // Combine the two positive middle taps with hardware bilinear sampling: 9 fetches
    // instead of 16. Keep negative outer taps separate to retain cubic reconstruction.
    vec2 p0 = (center - 1.0) / size;
    vec2 p1 = (center + w2 / middle) / size;
    vec2 p2 = (center + 2.0) / size;
    vec2 lo = 0.5 / size;
    vec2 hi = vec2(1.0) - lo;
    p0 = clamp(p0, lo, hi);
    p1 = clamp(p1, lo, hi);
    p2 = clamp(p2, lo, hi);
    vec4 color =
        texture(texture0, vec2(p0.x, p0.y)) * w0.x * w0.y +
        texture(texture0, vec2(p1.x, p0.y)) * middle.x * w0.y +
        texture(texture0, vec2(p2.x, p0.y)) * w3.x * w0.y +
        texture(texture0, vec2(p0.x, p1.y)) * w0.x * middle.y +
        texture(texture0, vec2(p1.x, p1.y)) * middle.x * middle.y +
        texture(texture0, vec2(p2.x, p1.y)) * w3.x * middle.y +
        texture(texture0, vec2(p0.x, p2.y)) * w0.x * w3.y +
        texture(texture0, vec2(p1.x, p2.y)) * middle.x * w3.y +
        texture(texture0, vec2(p2.x, p2.y)) * w3.x * w3.y;
    return clamp(color, 0.0, 1.0);
}

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
    vec2 eyeUv = clamp(vec2(1.0 - u, v), 0.0, 1.0);

    finalColor = sampleEye(eyeUv) * fragColor;
}
`;
