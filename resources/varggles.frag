#version 450

layout (location = 0) in vec2 uv; // Input UV from vertex shader (0,0 bottom-left to 1,1 top-right)

// Uniforms
layout (binding = 0) uniform sampler2D sourceTexture; // Combined left/right eye texture

// Uniform block for parameters (alternative to separate uniforms)
// Or use separate uniforms: uniform mat4 lookRotation; uniform float halfFOVInRadians;
uniform mat4 lookRotation;
uniform float halfFOVInRadians;

layout (location = 0) out vec4 outColor;

const float PI = 3.141592;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

void main() {
    // convert UV (0,0 bottom-left) (1, 1 top-right) to XY (-1,-1 lower left) (1, 1 upper right)
    vec2 xy = uv * 2.0 - 1.0;

    // Convert XY to equirectangular angles: (-pi, -pi_half) lower left, (pi, pi_half) upper right
    xy *= vec2(PI, HALF_PI);

    // Determine if the target pixel corresponds to the left (top half) or right (bottom half) eye view
    // In the input texture: Left eye V=[0.5, 1.0], Right eye V=[0.0, 0.5]
    // We need to map the calculated eye UVs back to these ranges in the source texture.
    // The original shader logic mapped equirect Y [-PI/2, PI/2] to determine top/bottom.
    // Let's keep the equirect calculation but use the output UV to decide which eye's *perspective* we are rendering.
    // A simpler approach might be needed depending on how the final panorama is structured.
    // Assuming the output panorama *itself* is split top/bottom for left/right eyes:
    bool renderLeftEye = uv.y > 0.5; // Rendering the top half of the output texture

    // Get scalar for modifying projection from cubemap (90 fov) to eye target fov
    float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI); // tan(PI/4) = 1

    // Create vector looking out at equirect CubeMap based on the target panorama pixel's angle
    vec3 cubeMapLookupDirection = vec3(sin(xy.x), 1.0, cos(xy.x)) * vec3(cos(xy.y), sin(xy.y), cos(xy.y));

    // Rotate look direction by the inverse view rotation
    cubeMapLookupDirection = (lookRotation * vec4(cubeMapLookupDirection, 0)).xyz;

    // Project the rotated vector onto the virtual "screen" of the source eye texture
    // U = ((X/|Z|) / fovScalar + 1) / 2
    // V = ((-Y/|Z|) / fovScalar + 1) / 2  (Inverting Y for texture coordinates)
    float u_eye = ((cubeMapLookupDirection.x / abs(cubeMapLookupDirection.z) / fovScalar) + 1.0) / 2.0;
    float v_eye = ((-cubeMapLookupDirection.y / abs(cubeMapLookupDirection.z) / fovScalar) + 1.0) / 2.0; // OpenGL V is often 0 at bottom
    vec2 eyeUV = vec2(u_eye, v_eye);

    // Clamp UVs to avoid sampling outside the texture bounds
    eyeUV = clamp(eyeUV, 0.0, 1.0);

    // Sample from the correct half of the source texture
    vec2 finalUV = eyeUV;
    if (renderLeftEye) {
        // Map V from [0, 1] to the top half [0.5, 1.0] of the source texture
        finalUV.y = finalUV.y * 0.5 + 0.5;
    } else {
        // Map V from [0, 1] to the bottom half [0.0, 0.5] of the source texture
        finalUV.y = finalUV.y * 0.5;
    }

    outColor = texture(sourceTexture, finalUV);
    // Debug: visualize UVs or other values if needed
    // outColor = vec4(uv.x, uv.y, 0.0, 1.0); // Visualize output UVs
    // outColor = vec4(eyeUV.x, eyeUV.y, 0.0, 1.0); // Visualize calculated eye UVs
    // outColor = texture(sourceTexture, uv); // Visualize direct source texture mapping
}