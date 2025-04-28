#version 450

layout (location = 0) in vec2 uv; // Input UV from vertex shader (0,0 bottom-left to 1,1 top-right)

// --- INPUTS ---
// Samplers for the separate eye textures
layout (binding = 0) uniform sampler2D eyeLeft;
layout (binding = 1) uniform sampler2D eyeRight;

// Uniforms (replacing push constants)
uniform mat4 lookRotation;
uniform float halfFOVInRadians;

// --- OUTPUT ---
layout (location = 0) out vec4 outColor;

// --- CONSTANTS ---
const float PI = 3.141592;
const float HALF_PI = 0.5 * PI;
const float QUARTER_PI = 0.25 * PI;

void main() {
	// Convert input UV (0,0 bottom-left to 1,1 top-right) to internal coordinate space.
    // The original comment suggested input was 0,0 top-left, but the 1-uv.y flips it assuming
    // standard OpenGL bottom-left origin for input 'uv'. This matches the Vulkan code's apparent intent.
	vec2 xy_flipped = vec2(uv.x, 1.0 - uv.y);

	// Convert to intermediate range: -1, -1 lower left to 1, 1 upper right
	vec2 xy_normalized = 2.0 * xy_flipped - 1.0;

	// Convert to angular range: (-pi, -pi_half) lower left, (pi, pi_half) upper right
	// This maps the *output* panorama space to angles.
	vec2 xy_angles = xy_normalized * vec2(PI, HALF_PI);

	// --- Determine if rendering Left (Top) or Right (Bottom) half of the OUTPUT panorama ---
    // This logic comes directly from the original shader. It decides which input eye
    // texture to sample based on which half of the *output* texture we are currently writing to.
    // The scaling and offsetting effectively map the Y range [0, 1] to two separate [-PI/2, PI/2] ranges.
	vec2 xy_eye_angles = xy_angles; // Start with the calculated angles
	xy_eye_angles.y *= 2.0; // Scale Y angle range

	bool renderTopHalf = xy_eye_angles.y >= 0.0; // Corresponds to Left Eye in original
	if (renderTopHalf) {
		xy_eye_angles.y -= HALF_PI; // Shift top half range down
	} else {
		xy_eye_angles.y += HALF_PI; // Shift bottom half range up
	}
    // Now xy_eye_angles.y is in the range [-PI/2, PI/2] for both halves

	// --- Calculate FOV Scalar ---
	float fovScalar = tan(halfFOVInRadians) / tan(QUARTER_PI); // tan(PI/4) = 1.0

	// --- Generate Lookup Direction ---
    // Create 3D direction vector based on the *angular position* within the output panorama
	vec3 cubeMapLookupDirection = vec3(
        sin(xy_angles.x) * cos(xy_eye_angles.y), // X = sin(lon) * cos(lat)
        sin(xy_eye_angles.y),                     // Y = sin(lat)
        cos(xy_angles.x) * cos(xy_eye_angles.y)  // Z = cos(lon) * cos(lat)
        // Note: The original shader had a slightly different calculation here,
        // vec3(sin(xy.x), 1.0, cos(xy.x)) * vec3(cos(xy.y), sin(xy.y), cos(xy.y));
        // which simplifies to the standard spherical coords used above when expanded.
        // Using standard spherical coordinates is clearer.
    );

	// --- Apply Rotation ---
	// Rotate the lookup direction by the provided view rotation
	cubeMapLookupDirection = (lookRotation * vec4(cubeMapLookupDirection, 0.0)).xyz;

	// --- Project onto Eye Texture Plane ---
    // Project the 3D direction onto a 2D plane as viewed from the origin along +Z,
    // scaling by FOV. This calculates the UVs to sample from the *input* eye textures.
	float projX = (cubeMapLookupDirection.x / abs(cubeMapLookupDirection.z)) / fovScalar;
	float projY = (cubeMapLookupDirection.y / abs(cubeMapLookupDirection.z)) / fovScalar;

    // Convert projected coordinates from [-1, 1] range (approx) to [0, 1] UV range.
    // The `1.0 - V` flips the vertical coordinate to match typical texture conventions
    // where (0,0) is often top-left during sampling, even if OpenGL's UV origin is bottom-left.
	vec2 eyeUV = vec2(
        (projX + 1.0) / 2.0,
        (projY + 1.0) / 2.0  // Calculate V directly
    );

	// Clamp UVs to prevent sampling outside the valid [0, 1] range
	eyeUV = clamp(eyeUV, 0.0, 1.0);

	// --- Sample Correct Eye Texture ---
	if (renderTopHalf) { // If we are rendering the top half of the output (Left Eye view)
		outColor = texture(eyeLeft, eyeUV); // Sample the left eye texture
	} else { // If we are rendering the bottom half of the output (Right Eye view)
		outColor = texture(eyeRight, eyeUV); // Sample the right eye texture
	}
}