#version 450
layout (location = 0) out vec2 uv;

// Fullscreen quad vertex positions (NDC)
const vec2 positions[4] = vec2[](
    vec2(-1.0, -1.0), // Bottom Left
    vec2( 1.0, -1.0), // Bottom Right
    vec2(-1.0,  1.0), // Top Left
    vec2( 1.0,  1.0)  // Top Right
);

// Corresponding UV coordinates (OpenGL convention: 0,0 is bottom-left)
const vec2 uvs[4] = vec2[](
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(1.0, 1.0)
);

out gl_PerVertex
{
    vec4 gl_Position;
};

void main()
{
    // Output position in Normalized Device Coordinates
    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    // Pass UV coordinates (0,0 bottom-left to 1,1 top-right) to fragment shader
    uv = uvs[gl_VertexID];
}