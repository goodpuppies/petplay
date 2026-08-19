#version 450
layout (location = 0) out vec2 uv;

// Cursor quad placement in normalized device coordinates.
// xy = center of the quad, zw = half extents.
uniform vec4 rect;
// 1.0 when the target texture is stored bottom-up, 0.0 when top-down.
uniform float flipV;

const vec2 corners[4] = vec2[](
    vec2(-1.0, -1.0), vec2( 1.0, -1.0),
    vec2(-1.0,  1.0), vec2( 1.0,  1.0)
);

out gl_PerVertex { vec4 gl_Position; };

void main() {
    vec2 corner = corners[gl_VertexID];
    gl_Position = vec4(rect.xy + corner * rect.zw, 0.0, 1.0);
    // Keep the sprite upright regardless of how the desktop frame was uploaded.
    float v = corner.y * 0.5 + 0.5;
    uv = vec2(corner.x * 0.5 + 0.5, mix(v, 1.0 - v, flipV));
}
