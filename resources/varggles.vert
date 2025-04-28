#version 450
layout (location = 0) out vec2 uv;

const vec2 positions[4] = vec2[](
    vec2(-1.0, -1.0), vec2( 1.0, -1.0),
    vec2(-1.0,  1.0), vec2( 1.0,  1.0)
);
const vec2 uvs_in[4] = vec2[]( // Rename original uvs
    vec2(0.0, 0.0), vec2(1.0, 0.0),
    vec2(0.0, 1.0), vec2(1.0, 1.0)
);

out gl_PerVertex { vec4 gl_Position; };

void main() {
    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    // Flip the V coordinate before passing to fragment shader
    uv = vec2(uvs_in[gl_VertexID].x, 1.0 - uvs_in[gl_VertexID].y);
}