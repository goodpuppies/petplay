/** Paged, bounded spatial SH cache. Coordinates and coefficients stay in Unity world space. */
import { floatBits, LIGHTING } from "./format.ts";

export const LV = {
  magic: 0x4c5631,
  version: 1,
  grid: 16,
  fineGrid: 32,
  maxNativeSamples: 4 * 1024 * 1024,
  // Three texels/sample: keep offsets exactly representable in float32 and height below 16384.
  maxTotalNativeSamples: 4 * 1024 * 1024,
  samplesPerPage: 128,
  coefficients: 12,
  metadata: 48,
  prefix: 12,
  maxVolumes: 32,
  // prefix, metadata, 128 SH samples, FNV checksum as two exactly representable uint16 floats
  words: 12 + 48 + 128 * 12 + 2,
  texelsPerVolume: 16 + 16 ** 3 * 3,
} as const;
export type LightVolume = {
  grid: number;
  dimensions: [number, number, number];
  native: boolean;
  raw: boolean;
  metadata: Float32Array;
  coefficients: Float32Array;
  at: number;
};
type Pending = LightVolume & { pages: Set<number>; signature: string };
export type LightVolumeSnapshot = {
  revision: number;
  dataRevision: number;
  count: number;
  additive: number;
  probesBlend: boolean;
  sharpBounds: boolean;
  maxAdditive: number;
  volumes: LightVolume[];
  texture: Float32Array;
  width: number;
  height: number;
};
export function volumeChecksum(values: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < values.length; i++) {
    h = Math.imul(h ^ floatBits(values[i] === 0 ? 0 : values[i]), 0x01000193) >>> 0;
  }
  return h;
}

export class LightVolumeCache {
  private pending = new Map<string, Pending>();
  private complete = new Map<number, LightVolume>();
  private configuration = "";
  private revision = 0;
  private dataRevision = 0;
  private built: LightVolumeSnapshot | null = null;
  private count = 0;
  private additive = 0;
  private probesBlend = false;
  private sharpBounds = false;
  private maxAdditive = 0;
  private lastSeen = 0;
  accepted = 0;
  corrupt = 0;
  unsupported: string | null = null;

  reset() {
    this.pending.clear();
    this.complete.clear();
    this.built = null;
    this.configuration = "";
    this.count = 0;
    this.lastSeen = 0;
    this.revision++;
    this.unsupported = null;
  }
  ingest(record: readonly number[] | undefined, now = Date.now()): boolean {
    const o = LIGHTING.length;
    if (
      !record || record.length < o + LV.words || record[o] !== LV.magic ||
      ![1, 2, 3, 4].includes(record[o + 1])
    ) return false;
    const p = record.slice(o, o + LV.words);
    const integer = (x: number, min: number, max: number) =>
      Number.isInteger(x) && x >= min && x <= max;
    const raw = p[1] === 4;
    const native = p[1] >= 3 && p[11] > 0;
    const dimensions: [number, number, number] = native
      ? [p[6], p[11] % 4096, Math.floor(p[11] / 4096)]
      : [p[6], p[6], p[6]];
    const samples = dimensions[0] * dimensions[1] * dimensions[2];
    if (
      !p.every(Number.isFinite) || !integer(p[2], 0, LV.maxVolumes) || !integer(p[3], 0, p[2]) ||
      !integer(p[4], 0, 31) || !dimensions.every((d) => integer(d, 1, 512)) ||
      (!native && ![LV.grid, LV.fineGrid].includes(p[6] as 16 | 32)) ||
      (p[1] === 1 && p[6] !== LV.grid) ||
      !integer(p[5], 0, Math.ceil(samples / LV.samplesPerPage) - 1) ||
      (p[1] >= 3 && !integer(p[11], 0, 512 * 4096 + 512)) ||
      !integer(p[7], 0, 1) || !integer(p[8], 0, 1) || !integer(p[9], 0, 3) ||
      !integer(p[LV.words - 2], 0, 65535) || !integer(p[LV.words - 1], 0, 65535) ||
      volumeChecksum(p.slice(0, -2)) !== ((p[LV.words - 2] | p[LV.words - 1] << 16) >>> 0)
    ) {
      this.corrupt++;
      return false;
    }
    if (!integer(p[10], 0, p[3])) {
      this.corrupt++;
      return false;
    }
    const config = [p[2], p[3], p[7], p[8], p[9], p[10], Number(raw)].join(":");
    if (this.configuration !== config || now - this.lastSeen > 15000) {
      this.reset();
      this.configuration = config;
    }
    this.lastSeen = now;
    this.count = p[2];
    this.additive = p[3];
    this.probesBlend = !!p[7];
    this.sharpBounds = !!p[8];
    this.maxAdditive = p[10];
    if (!this.count) return true;
    const id = p[4], page = p[5];
    if (id >= this.count) {
      this.corrupt++;
      return false;
    }
    const metadata = Float32Array.from(p.slice(LV.prefix, LV.prefix + LV.metadata));
    if (p[1] >= 3 && metadata[47] < 0) {
      this.unsupported = `Volume ${id} native atlas exceeds export budget; coarse data only`;
    }
    if (native && samples > LV.maxNativeSamples) {
      this.unsupported = `Volume ${id} exceeds native sample budget (${dimensions.join("x")})`;
      return false;
    }
    // Includes transform, bounds/colour/rotation and fixed atlas sentinel: new data resets assembly.
    const signatureFor = (m: Float32Array) =>
      raw ? [m[19], m[27], m[31], ...m.slice(32)].join(",") : Array.from(m).join(",");
    const signature = signatureFor(metadata);
    const grid = p[6], key = `${id}:${native ? "native" : "grid"}:${dimensions.join("x")}`;
    let item = this.pending.get(key);
    if (!item || item.signature !== signature) {
      if (native) {
        const others = [...this.pending].filter(([k, v]) => v.native && !k.startsWith(`${id}:`));
        if (
          samples + others.reduce((sum, [, v]) => sum + v.coefficients.length / 12, 0) >
            LV.maxTotalNativeSamples
        ) {
          this.unsupported = "Combined native grids exceed sample budget";
          return false;
        }
      }
      for (const [k, v] of this.pending) {
        if (
          k.startsWith(`${id}:`) && v.native === native &&
          (native || v.grid === grid)
        ) this.pending.delete(k);
      }
      item = {
        grid,
        dimensions,
        native,
        raw,
        metadata,
        coefficients: new Float32Array(samples * LV.coefficients),
        pages: new Set(),
        signature,
        at: now,
      };
      this.pending.set(key, item);
      // A changed transform must never reuse an old volume in the new location.
      const previous = this.complete.get(id);
      if (previous && signatureFor(previous.metadata) !== signature) {
        this.complete.delete(id);
        this.built = null;
      }
    }
    if (raw) {
      item.metadata.set(metadata);
      const previous = this.complete.get(id);
      if (
        previous && signatureFor(previous.metadata) === signature &&
        previous.metadata.some((v, i) => v !== metadata[i])
      ) {
        previous.metadata.set(metadata);
        this.revision++;
        if (this.built) {
          this.built.texture.set(metadata, id * 64);
          this.built.revision = this.revision;
        }
      }
    }
    const start = page * LV.samplesPerPage * LV.coefficients;
    item.coefficients.set(
      p.slice(
        LV.prefix + LV.metadata,
        LV.prefix + LV.metadata +
          Math.min(LV.samplesPerPage * LV.coefficients, item.coefficients.length - start),
      ),
      start,
    );
    item.pages.add(page);
    item.at = now;
    this.accepted++;
    if (item.pages.size === Math.ceil(samples / LV.samplesPerPage)) {
      // A later coarse refresh must not downgrade a finished fine volume.
      const previous = this.complete.get(id);
      if (native || (!previous?.native && grid >= (previous?.grid ?? 0))) {
        this.complete.set(id, {
          grid,
          dimensions,
          native,
          raw,
          metadata: item.metadata.slice(),
          coefficients: item.coefficients.slice(),
          at: now,
        });
        this.revision++;
        this.dataRevision++;
        this.built = null;
      }
      item.pages.clear();
    }
    return true;
  }
  snapshot(now = Date.now()): LightVolumeSnapshot | null {
    if (!this.count || now - this.lastSeen > 5000) return null;
    const volumes: LightVolume[] = [];
    for (let id = 0; id < this.count; id++) {
      const v = this.complete.get(id);
      // Native sweep length depends on the world's data. Metadata invalidation and the
      // five-second stream timeout guard cached volumes while long sweeps complete.
      if (!v) return null;
      volumes.push(v);
    }
    if (!this.built) {
      const metadataTexels = LV.maxVolumes * 16;
      const texels = metadataTexels +
        volumes.reduce((sum, v) => sum + v.coefficients.length / 4, 0);
      const width = 1024, height = Math.ceil(texels / width);
      const texture = new Float32Array(width * height * 4);
      let sampleOffset = metadataTexels;
      volumes.forEach((v, id) => {
        const offset = id * 16 * 4;
        texture.set(v.metadata, offset);
        texture.set([...v.dimensions, sampleOffset], offset + 48);
        texture.set(
          v.native
            ? [v.metadata[44], v.metadata[45], v.metadata[46], 1]
            : [v.dimensions[0] - 1, v.dimensions[1] - 1, v.dimensions[2] - 1, 0],
          offset + 52,
        );
        texture.set(
          v.native ? [v.metadata[19], v.metadata[27], v.metadata[31], 0] : [0, 0, 0, 0],
          offset + 56,
        );
        texture[offset + 60] = Number(v.raw);
        for (let sample = 0; sample < v.coefficients.length / 12; sample++) {
          const src = sample * 12, dst = sampleOffset * 4 + sample * 12;
          // Three texels, one (L1.xyz, L0) per colour channel.
          for (let c = 0; c < 3; c++) {
            const at = dst + c * 4, from = src + 3 + c * 3;
            texture[at] = v.coefficients[from];
            texture[at + 1] = v.coefficients[from + 1];
            texture[at + 2] = v.coefficients[from + 2];
            texture[at + 3] = v.coefficients[src + c];
          }
        }
        sampleOffset += v.coefficients.length / 4;
      });
      this.built = {
        revision: this.revision,
        dataRevision: this.dataRevision,
        count: this.count,
        additive: this.additive,
        probesBlend: this.probesBlend,
        sharpBounds: this.sharpBounds,
        maxAdditive: this.maxAdditive,
        volumes,
        texture,
        width,
        height,
      };
    }
    return this.built;
  }
  status(now = Date.now()) {
    let coveragePages = 0;
    for (let id = 0; id < this.count; id++) {
      coveragePages += this.complete.has(id)
        ? 32
        : this.pending.get(`${id}:grid:16x16x16`)?.pages.size ?? 0;
    }
    return {
      count: this.count,
      complete: this.complete.size,
      coveragePages,
      coverageTotal: this.count * 32,
      refined: [...this.complete.values()].filter((v) => v.grid === LV.fineGrid).length,
      native: [...this.complete.values()].filter((v) => v.native).length,
      unsupported: this.unsupported,
      grids: [...this.complete].map(([id, v]) => ({
        id,
        grid: v.grid,
        dimensions: v.dimensions,
        native: v.native,
      })),
      pages: [...this.pending].map(([key, v]) => ({
        key,
        pages: v.pages.size,
        total: Math.ceil(v.coefficients.length / 12 / LV.samplesPerPage),
      })),
      ready: this.snapshot(now) != null,
      accepted: this.accepted,
      corrupt: this.corrupt,
      ageMs: this.lastSeen ? now - this.lastSeen : null,
    };
  }
}
export const lightVolumeCache = new LightVolumeCache();

/** Packed texture sampler, shared with tests/GPU probe. Matches the installed v2/v3 regular rules. */
export const LIGHT_VOLUME_GLSL = `
uniform sampler2D texture3;
uniform vec4 uLV; // count, additive count, probesBlend, sharpBounds
uniform float uLVMaxAdditive;
uniform float uLVStrength; // 1 = original, >1 exaggerates difference from the probe for debugging
vec4 lvTexel(int index) { ivec2 s=textureSize(texture3,0); return texelFetch(texture3,ivec2(index%s.x,index/s.x),0); }
vec4 lvMeta(int id,int k) { return lvTexel(id*16+k); }
vec3 lvLocal(int id,vec3 p) {
  return vec3(dot(lvMeta(id,0),vec4(p,1)),dot(lvMeta(id,1),vec4(p,1)),dot(lvMeta(id,2),vec4(p,1)));
}
bool lvContains(vec3 p) { return all(lessThanEqual(abs(p),vec3(0.5))); }
vec3 lvSample(int id,vec3 local,vec3 n) {
  vec4 gridInfo=lvMeta(id,12);ivec3 size=ivec3(gridInfo.xyz);
  vec3 p=clamp(clamp(local+0.5,0.0,1.0)*lvMeta(id,13).xyz+lvMeta(id,14).xyz,vec3(0),gridInfo.xyz-1.0), f=fract(p);
  bool raw=lvMeta(id,15).x>0.5;vec4 tint=lvMeta(id,5);
  if(raw && tint.a!=0.0) {vec3 a=lvMeta(id,6).xyz,b=lvMeta(id,7).xyz;n=n.x*a+n.y*b+n.z*cross(a,b);}
  ivec3 base=ivec3(floor(p)); vec3 result=vec3(0);
  for(int z=0;z<2;z++) for(int y=0;y<2;y++) for(int x=0;x<2;x++) {
    ivec3 at=min(base+ivec3(x,y,z),size-1);
    float w=(x==0?1.0-f.x:f.x)*(y==0?1.0-f.y:f.y)*(z==0?1.0-f.z:f.z);
    int t=int(gridInfo.w)+3*(at.x+size.x*(at.y+size.y*at.z));
    result+=w*vec3(dot(lvTexel(t),vec4(n,1)),dot(lvTexel(t+1),vec4(n,1)),dot(lvTexel(t+2),vec4(n,1)));
  } return raw ? result*tint.rgb : result;
}
vec3 shadeVolumes(vec3 p,vec3 n,vec3 probe) {
  if(uLV.x<0.5) return probe;
  int count=int(uLV.x), additive=int(uLV.y), a=-1, b=-1;
  vec3 la=vec3(0), lb=vec3(0), last=vec3(0); float mask=1.0;
  for(int id=0;id<32;id++) {
    if(id<additive || id>=count) continue;
    vec3 local=lvLocal(id,p); last=local;
    if(lvContains(local)) {
      if(a<0) { a=id;la=local;vec3 fade=clamp((0.5-abs(local))*lvMeta(id,4).xyz,0.0,1.0);mask=fade.x*fade.y*fade.z;if(mask>=1.0) break; }
      else { b=id;lb=local;break; }
    }
  }
  vec3 regular=probe;
  if(a<0 && uLV.z<0.5 && count>additive) {a=count-1;la=last;}
  if(a>=0) {
    vec3 va=lvSample(a,la,n);
    if(mask>=1.0 || (b<0 && uLV.w>0.5)) regular=va;
    else { vec3 vb=b>=0?lvSample(b,lb,n):(uLV.z>0.5?probe:lvSample(count-1,last,n));regular=mix(vb,va,mask); }
  }
  int added=0;
  for(int id=0;id<32;id++) {if(id>=additive || added>=int(uLVMaxAdditive)) break;vec3 local=lvLocal(id,p);if(lvContains(local)) {regular+=lvSample(id,local,n);added++;}}
  return max(probe + uLVStrength * (max(regular,vec3(0)) - probe),vec3(0));
}
`;
