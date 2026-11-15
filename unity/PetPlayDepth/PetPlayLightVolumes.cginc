// Paged spatial SH export, sampled from VRC Light Volumes' public v2/v3 globals.
// Atlas packing and rotation follow red.sim.lightvolumes (RED_SIM, MIT; see accompanying license).
#ifndef PETPLAY_LIGHT_VOLUMES_INCLUDED
#define PETPLAY_LIGHT_VOLUMES_INCLUDED
#define PPD_LV_SAMPLES 128u
#define PPD_LV_WORDS 1598u
float4x4 _UdonLightVolumeInvWorldMatrix[32];
float4 _UdonLightVolumeRotation[64];
float3 _UdonLightVolumeInvLocalEdgeSmooth[32];
float4 _UdonLightVolumeUvwScale[96];
float3 _UdonLightVolumeUvw[192];
float4 _UdonLightVolumeColor[32];
float _UdonLightVolumeAdditiveMaxOverdraw;
Texture3D<float4> _UdonLightVolume;
SamplerState sampler_UdonLightVolume;

uint PPDLVCount() {
    // Legacy v2 managers can omit Enabled while still publishing Version and Count.
    bool supported = _UdonLightVolumeVersion >= 0 && _UdonLightVolumeVersion <= 3;
    bool enabled = _UdonLightVolumeVersion == 2 || _UdonLightVolumeEnabled != 0;
    return supported && enabled ? (uint)clamp(round(_UdonLightVolumeCount), 0, 32) : 0u;
}
// Legacy v0/v1 uses min/max pairs for each atlas island; v2/v3 uses min + shared scale.
void PPDLVUvw(uint id, out float3 u, out float3 v, out float3 w, out float3 scale) {
    if(_UdonLightVolumeVersion < 2) {
        uint o=id*6u;u=_UdonLightVolumeUvw[o];v=_UdonLightVolumeUvw[o+2u];w=_UdonLightVolumeUvw[o+4u];
        scale=_UdonLightVolumeUvw[o+1u]-u;
    } else {
        uint o=id*3u;u=_UdonLightVolumeUvwScale[o].xyz;v=_UdonLightVolumeUvwScale[o+1u].xyz;
        w=_UdonLightVolumeUvwScale[o+2u].xyz;
        scale=float3(_UdonLightVolumeUvwScale[o].w,_UdonLightVolumeUvwScale[o+1u].w,_UdonLightVolumeUvwScale[o+2u].w);
    }
}
uint PPDLVTick() { return (uint)floor(_Time.y * 20.0); }
// Preserve native atlas texel centres, including the boundary taps needed by trilinear sampling.
void PPDLVSampling(uint id, out uint3 size, out int3 first, out float3 scale, out float3 bias) {
    uint w,h,d; _UdonLightVolume.GetDimensions(w,h,d);
    float3 dimensions=float3(w,h,d);
    float3 u,v,t,uvScale;PPDLVUvw(id,u,v,t,uvScale);
    float3 start=u*dimensions-0.5;
    scale=uvScale*dimensions;
    first=(int3)floor(start+0.0001);
    int3 last=(int3)ceil(start+scale-0.0001);
    size=(uint3)max(last-first+1,1);
    bias=start-(float3)first;
}
uint PPDLVNativePages(uint id) {
    uint3 size;int3 first;float3 scale,bias;PPDLVSampling(id,size,first,scale,bias);
    if(any(size>512u)) return 0u;
    uint samples=size.x*size.y*size.z;
    if(samples>4194304u) return 0u;
    return (samples+PPD_LV_SAMPLES-1u)/PPD_LV_SAMPLES;
}
// Resolve once per value: calling separate id/page/phase helpers repeated the entire sweep scan.
void PPDLVSchedule(uint count, out uint id, out uint page, out bool native) {
    id=0u;page=0u;native=false;
    if(count==0u) return;
    uint coarse=count*32u, tick=PPDLVTick();
    #if defined(PPD_LV_CHECK_FINE)
        uint slot=0u;
        native=true;
    #else
        // Interleave coverage with native refinement: one lost coarse page must not wait
        // behind every world's large native grid before it is retransmitted.
        native=(tick&1u)!=0u;
        if(!native) {uint coverage=(tick/2u)%coarse;id=coverage/32u;page=coverage%32u;return;}
        uint total=0u;
        [loop] for(uint v=0u;v<count;v++) total+=PPDLVNativePages(v);
        if(total==0u) {native=false;uint coverage=(tick/2u)%coarse;id=coverage/32u;page=coverage%32u;return;}
        uint slot=(tick/2u)%total;
    #endif
    [loop] for(uint v=0u;v<count;v++) {
        uint pages=PPDLVNativePages(v);
        if(slot<pages) {id=v;page=slot;return;}
        slot-=pages;
    }
}
void PPDLVAtlas(uint id, float3 local, out float4 a, out float4 b, out float4 c) {
    float3 u,v,w,scale;PPDLVUvw(id,u,v,w,scale);
    float3 at=saturate(local+0.5)*scale;
    a=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,u+at,0);
    b=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,v+at,0);
    c=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,w+at,0);
}
float3 PPDLVRotate(uint id,float3 v) {
    float3 a=_UdonLightVolumeRotation[id*2u].xyz, b=_UdonLightVolumeRotation[id*2u+1u].xyz;
    // Matrix-vector convention of LV_MultiplyVectorByMatrix3x3.
    return float3(dot(a,v),dot(b,v),dot(cross(a,b),v));
}
float PPDLVData(uint i) {
    uint count=PPDLVCount(),id,page;bool native;PPDLVSchedule(count,id,page,native);
    uint3 size=uint3(16u,16u,16u),nativeSize;int3 first;float3 scale,bias;
    PPDLVSampling(id,nativeSize,first,scale,bias);
    if(native) size=nativeSize;
    if(i==0u) return 5002801.0; // 0x4c5631
    if(i==1u) return 4;
    if(i==2u) return count;
    if(i==3u) return min((uint)max(round(_UdonLightVolumeAdditiveCount),0),count);
    if(i==4u) return id;
    if(i==5u) return page;
    if(i==6u) return size.x;
    if(i==7u) return _UdonLightVolumeProbesBlend != 0 ? 1 : 0;
    if(i==8u) return _UdonLightVolumeSharpBounds != 0 ? 1 : 0;
    if(i==9u) return clamp(round(_UdonLightVolumeVersion),0,3);
    if(i==10u) return _UdonLightVolumeVersion == 2 ? min((uint)max(round(_UdonLightVolumeAdditiveCount),0),count)
        : clamp(round(_UdonLightVolumeAdditiveMaxOverdraw),0,min(_UdonLightVolumeAdditiveCount,count));
    if(i==11u) return native ? size.y+size.z*4096u : 0u;
    if(i<12u || count==0u) return 0;
    if(i<60u) {
        uint k=i-12u;
        if(k<16u) return _UdonLightVolumeInvWorldMatrix[id][k/4u][k%4u];
        if(k<20u) return k<19u ? _UdonLightVolumeInvLocalEdgeSmooth[id][k-16u] : bias.x;
        if(k<24u) return _UdonLightVolumeColor[id][k-20u];
        if(k<32u) {if(k==27u) return bias.y;if(k==31u) return bias.z;
            return _UdonLightVolumeRotation[id*2u+(k-24u)/4u][k%4u];}
        if(k<44u) {
            float4 a,b,c; PPDLVAtlas(id,0,a,b,c);
            return k<36u?a[k-32u]:k<40u?b[k-36u]:c[k-40u];
        }
        return k<47u ? scale[k-44u] : (PPDLVNativePages(id)>0u?1:-1);
    }
    uint sample=page*PPD_LV_SAMPLES+(i-60u)/12u, component=(i-60u)%12u;
    if(sample>=size.x*size.y*size.z) return 0;
    uint3 xyz=uint3(sample%size.x,(sample/size.x)%size.y,sample/(size.x*size.y));
    float4 a,b,c;
    if(native) {
        uint w,h,d;_UdonLightVolume.GetDimensions(w,h,d);
        float3 at=((float3)first+(float3)xyz+0.5)/float3(w,h,d);
        // Identical offsets for the three islands. Sample at exact atlas texel centres.
        float3 u,v,t,uvScale;PPDLVUvw(id,u,v,t,uvScale);
        a=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,at,0);
        b=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,at+v-u,0);
        c=_UdonLightVolume.SampleLevel(sampler_UdonLightVolume,at+t-u,0);
    } else PPDLVAtlas(id,(float3)xyz/15.0-0.5,a,b,c);
    float4 tint=_UdonLightVolumeColor[id];
    if(component<3u) return a[component];
    uint ch=(component-3u)/3u;
    float3 l1=float3(b[ch],c[ch],ch==0u?a.a:ch==1u?b.a:c.a);
    return l1[(component-3u)%3u];
}
float PPDLVFloat(uint i) {
    if(i<PPD_LV_WORDS-2u) return PPDLVData(i);
    uint hash=0x811c9dc5u;
    [loop] for(uint k=0u;k<PPD_LV_WORDS-2u;k++) {
        float f=PPDLVData(k);uint bits=asuint(f);if((bits&0x7fffffffu)==0u) bits=0u;
        hash=(hash^bits)*0x01000193u;
    }
    return i==PPD_LV_WORDS-2u ? (hash&65535u) : (hash>>16u);
}
#endif
