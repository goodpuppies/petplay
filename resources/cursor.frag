#version 450

layout (location = 0) in vec2 uv;
layout (location = 0) out vec4 fragColor;

layout (binding = 0) uniform sampler2D cursorTex;

void main() {
    fragColor = texture(cursorTex, uv);
}
