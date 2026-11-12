#version 330
// GLSL adaptation of pmndrs/glyph Slug dilation, pinned in README.md (MIT).
layout(location=0) in vec2 corner;
layout(location=1) in mat4 instanceMvp;
layout(location=5) in vec4 instanceBounds;
layout(location=6) in uvec4 instanceOffsets;
layout(location=7) in uvec2 instanceBands;
layout(location=8) in vec4 instanceBandTransform;
layout(location=9) in vec4 instanceTint;
flat out uvec4 uOffsets;
flat out uvec2 uBands;
flat out vec4 uBandTransform;
flat out vec4 uTint;
#define uMvp instanceMvp
#define uBounds instanceBounds

uniform vec2 uViewport;
out vec2 renderCoordinate;
void main() {
    uOffsets=instanceOffsets; uBands=instanceBands;
    uBandTransform=instanceBandTransform; uTint=instanceTint;
    vec2 p = mix(uBounds.xy, uBounds.zw, corner * 0.5 + 0.5);
    vec4 clip = uMvp * vec4(p,0,1);
    vec2 r0 = vec2(uMvp[0].x,uMvp[1].x);
    vec2 r1 = vec2(uMvp[0].y,uMvp[1].y);
    vec2 r3 = vec2(uMvp[0].w,uMvp[1].w);
    vec2 tx = vec2(clip.w*r0.x-clip.x*r3.x,clip.w*r1.x-clip.y*r3.x)*uViewport;
    vec2 ty = vec2(clip.w*r0.y-clip.x*r3.y,clip.w*r1.y-clip.y*r3.y)*uViewport;
    float lx=abs(tx.x)+abs(tx.y), ly=abs(ty.x)+abs(ty.y);
    float area=abs(tx.x*ty.y-tx.y*ty.x);
    float denominator=max(max(area-clip.w*(corner.x*r3.x*ly+corner.y*r3.y*lx),area*0.5),1e-30);
    vec2 offset=corner*vec2(ly,lx)*clip.w*clip.w/denominator;
    renderCoordinate=p+offset;
    gl_Position=uMvp*vec4(renderCoordinate,0,1);
}
