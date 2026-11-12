#version 330
// Modified GLSL port of Rune's Windfoil box integral; see WINDFOIL-NOTICE.md.
// Full-float xy-monotone quadratics; shared Glyph instancing/placement only.
in vec2 renderCoordinate;
out vec4 finalColor;
uniform sampler2D uCurves;
uniform float uCoverageExponent;
uniform float uWeightPixels;
uniform float uAaWidth;
flat in uvec4 uOffsets;
flat in uvec2 uBands;
flat in vec4 uTint;
vec4 pieceTexel(uint index) {
    int width=textureSize(uCurves,0).x;
    return texelFetch(uCurves,ivec2(int(index)%width,int(index)/width),0);
}
float monoRoot(float p0,float p1,float p2,float value) {
    bool rising=p2>=p0;
    float sg=rising?1.0:-1.0;
    float c=p0-value;
    if(c*sg>=0.0) return 0.0;
    if((p2-value)*sg<=0.0) return 1.0;
    float a=p0-2.0*p1+p2,b=2.0*(p1-p0);
    float sq=sqrt(max(b*b-4.0*a*c,0.0));
    float qq=-0.5*(b+(b>=0.0?sq:-sq));
    bool first=(b<0.0)==rising;
    float numerator=first?qq:c,denominator=first?a:qq;
    return denominator!=0.0?clamp(numerator/denominator,0.0,1.0):0.0;
}
float insideIntegral(vec2 a2,vec2 a1,float x0,float ta,float tb,float hx) {
    if(tb<=ta) return 0.0;
    float tm=0.5*(ta+tb),d=0.5*(tb-ta);
    float xm=(a2.x*tm+a1.x)*tm+x0+hx;
    vec2 dm=2.0*a2*tm+a1;
    return 2.0*d*xm*dm.y+(2.0*d*d*d/3.0)*(a2.x*dm.y+2.0*a2.y*dm.x);
}
float integratePiece(vec2 p0,vec2 p1,vec2 p2,vec2 halfBox) {
    float hx=halfBox.x,hy=halfBox.y;
    float lo=max(-hy,min(p0.y,p2.y)),hi=min(hy,max(p0.y,p2.y));
    if(hi<=lo || max(p0.x,p2.x)<=-hx) return 0.0;
    if(min(p0.x,p2.x)>=hx) return 2.0*hx*(clamp(p2.y,-hy,hy)-clamp(p0.y,-hy,hy));
    bool yr=p2.y>=p0.y,xr=p2.x>=p0.x;
    float ta=monoRoot(p0.y,p1.y,p2.y,yr?lo:hi);
    float tb=monoRoot(p0.y,p1.y,p2.y,yr?hi:lo);
    float tx0=clamp(monoRoot(p0.x,p1.x,p2.x,-hx),ta,tb);
    float tx1=clamp(monoRoot(p0.x,p1.x,p2.x,hx),ta,tb);
    float t1=xr?tx0:tx1,t2=max(xr?tx1:tx0,t1);
    vec2 a2=p0-2.0*p1+p2,a1=2.0*(p1-p0);
    float acc=insideIntegral(a2,a1,p0.x,t1,t2,hx);
    float ra=xr?t2:ta,rb=xr?tb:t1;
    float d=max(rb-ra,0.0),tm=0.5*(ra+rb);
    return acc+d*(2.0*a2.y*tm+a1.y)*(2.0*hx);
}
float coverageAt(vec2 position,vec2 halfBox) {
    float winding=0.0;
    for(uint i=0u;i<uBands.x;i++) {
        vec4 a=pieceTexel(uOffsets.x+2u*i),b=pieceTexel(uOffsets.x+2u*i+1u);
        winding+=integratePiece(a.xy-position,a.zw-position,b.xy-position,halfBox);
    }
    return clamp(abs(winding)/(4.0*halfBox.x*halfBox.y),0.0,1.0);
}
void main() {
    vec2 dx=dFdx(renderCoordinate),dy=dFdy(renderCoordinate);
    // Local axis-aligned footprint, as in the upstream 2D method. Under
    // perspective this is a derivative-based approximation to the pixel shape.
    vec2 halfBox=0.5*max((abs(dx)+abs(dy))*uAaWidth,vec2(1.0/65536.0));
    float coverage=coverageAt(renderCoordinate,halfBox);
    if(uWeightPixels>0.0) {
        vec2 x=dx*uWeightPixels,y=dy*uWeightPixels;
        coverage=max(coverage,max(coverageAt(renderCoordinate+x,halfBox),coverageAt(renderCoordinate-x,halfBox)));
        coverage=max(coverage,max(coverageAt(renderCoordinate+y,halfBox),coverageAt(renderCoordinate-y,halfBox)));
    }
    if(uCoverageExponent!=1.0) coverage=pow(coverage,uCoverageExponent);
    finalColor=vec4(uTint.rgb,uTint.a*coverage);
}
