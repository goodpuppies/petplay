#version 330
// GLSL adaptation of pmndrs/glyph Slug coverage/root/band routines (MIT).
// Curve RGBA16F + header R32UI + reference R16UI storage straight from Glyph's packer.
in vec2 renderCoordinate;
out vec4 finalColor;
uniform sampler2D uCurves;
uniform usampler2D uHeaders;
uniform usampler2D uReferences;
uniform float uCoverageExponent;
uniform float uWeightPixels;
uniform float uAaWidth;
flat in uvec4 uOffsets; // curve base, horizontal header, vertical header, reference base
flat in uvec2 uBands;
flat in vec4 uBandTransform;
flat in vec4 uTint;
ivec2 address(uint index,int width) { return ivec2(int(index)%width,int(index)/width); }
uint header(uint index) { return texelFetch(uHeaders,address(index,textureSize(uHeaders,0).x),0).r; }
uint reference(uint index) { return texelFetch(uReferences,address(index,textureSize(uReferences,0).x),0).r; }
vec4 curveTexel(uint index) { return texelFetch(uCurves,address(index,textureSize(uCurves,0).x),0); }
uint rootCode(float a,float b,float c) {
    uint signs=uint(a<0.0)|(uint(b<0.0)<<1u)|(uint(c<0.0)<<2u);
    return (0x2e74u>>signs)&0x0101u;
}
vec2 stableRoots(float a,float b,float c) {
    if(abs(a)<1.0/65536.0) return vec2(c/(2.0*b));
    float d=b*b-a*c;
    if(d<=0.0) return vec2(b/a);
    float q=b+(b>=0.0?1.0:-1.0)*sqrt(d);
    vec2 roots=vec2(q/a,c/q);
    return b>=0.0?roots.yx:roots;
}
vec2 evaluateBand(bool horizontal, float pixelsPerEm, vec2 position) {
    float coordinate=horizontal?position.y:position.x;
    float scale=horizontal?uBandTransform.y:uBandTransform.x;
    float bias=horizontal?uBandTransform.w:uBandTransform.z;
    uint count=horizontal?uBands.x:uBands.y;
    uint band=uint(clamp(coordinate*scale+bias,0.0,float(count)-1.0));
    uint h=header((horizontal?uOffsets.y:uOffsets.z)+band);
    uint n=min(h>>16u,512u), first=uOffsets.w+(h&65535u);
    float coverage=0.0,weight=0.0;
    for(uint i=0u;i<n;i++) {
        uint index=uOffsets.x+reference(first+i);
        vec4 c0=curveTexel(index), c1=curveTexel(index+1u);
        vec2 p0=c0.xy-position,p1=c0.zw-position,p2=c1.xy-position;
        float maximum=horizontal?max(max(p0.x,p1.x),p2.x):max(max(p0.y,p1.y),p2.y);
        if(maximum*pixelsPerEm < -0.5) break;
        vec3 axis=horizontal?vec3(p0.y,p1.y,p2.y):vec3(p0.x,p1.x,p2.x);
        uint code=rootCode(axis.x,axis.y,axis.z);
        if(code==0u) continue;
        vec2 t=stableRoots(axis.x-2.0*axis.y+axis.z,axis.x-axis.y,axis.x);
        vec3 other=horizontal?vec3(p0.x,p1.x,p2.x):vec3(p0.y,p1.y,p2.y);
        vec2 roots=((other.x-2.0*other.y+other.z)*t-2.0*(other.x-other.y))*t+other.x;
        roots*=pixelsPerEm;
        vec2 contributions=clamp(roots+0.5,0.0,1.0);
        bool firstRoot=(code&1u)!=0u,secondRoot=(code&256u)!=0u;
        float a=firstRoot?contributions.x:0.0,b=secondRoot?contributions.y:0.0;
        coverage+=horizontal?a-b:b-a;
        vec2 weights=clamp(1.0-2.0*abs(roots),0.0,1.0);
        weight=max(weight,max(firstRoot?weights.x:0.0,secondRoot?weights.y:0.0));
    }
    return vec2(coverage,weight);
}
float glyphCoverage(vec2 position, vec2 pixelsPerEm) {
    vec2 x=evaluateBand(true,pixelsPerEm.x,position),y=evaluateBand(false,pixelsPerEm.y,position);
    float weighted=abs(x.x*x.y+y.x*y.y)/max(x.y+y.y,1.0/65536.0);
    return clamp(max(weighted,min(abs(x.x),abs(y.x))),0.0,1.0);
}
void main() {
    vec2 dx=dFdx(renderCoordinate),dy=dFdy(renderCoordinate);
    // Narrow only the reconstruction footprint. Weight offsets below remain in
    // actual eye pixels, independent of this scale; glyph coordinates do not move.
    vec2 pixelsPerEm=1.0/max((abs(dx)+abs(dy))*uAaWidth,vec2(1.0/65536.0));
    float coverage=glyphCoverage(renderCoordinate,pixelsPerEm);
    if(uWeightPixels>0.0) {
        // Experimental cross-shaped dilation of coverage in eye pixels. Retain
        // the original outline, advances and perspective; no bitmap max filter.
        vec2 x=dx*uWeightPixels,y=dy*uWeightPixels;
        coverage=max(coverage,max(glyphCoverage(renderCoordinate+x,pixelsPerEm),glyphCoverage(renderCoordinate-x,pixelsPerEm)));
        coverage=max(coverage,max(glyphCoverage(renderCoordinate+y,pixelsPerEm),glyphCoverage(renderCoordinate-y,pixelsPerEm)));
    }
    // Coverage shaping, not a framebuffer gamma correction. Preserve exact
    // empty/full coverage and keep baseline exponent 1 bit-for-bit unchanged.
    if(uCoverageExponent!=1.0) coverage=pow(coverage,uCoverageExponent);
    finalColor=vec4(uTint.rgb,uTint.a*coverage);
}
