import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";

/**
 * Narrow Web-Audio-shaped API for Three.js. This is intentionally not a browser
 * polyfill: it models the nodes Three's Audio / PositionalAudio create and lets
 * the native backend consume their final parameters.
 */
export class RaylibAudioParam {
  constructor(public value: number) {}
  setValueAtTime(value: number, _time: number) { this.value = value; return this; }
  setTargetAtTime(value: number, _time: number, _constant: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number, _time: number) { this.value = value; return this; }
}

export class RaylibAudioNode {
  readonly outputs = new Set<RaylibAudioNode>();
  connect<T extends RaylibAudioNode>(destination: T): T { this.outputs.add(destination); return destination; }
  disconnect(destination?: RaylibAudioNode) {
    if (destination) this.outputs.delete(destination);
    else this.outputs.clear();
  }
}

export class RaylibGainNode extends RaylibAudioNode {
  readonly gain = new RaylibAudioParam(1);
}

export class RaylibPannerNode extends RaylibAudioNode {
  readonly positionX = new RaylibAudioParam(0);
  readonly positionY = new RaylibAudioParam(0);
  readonly positionZ = new RaylibAudioParam(0);
  readonly orientationX = new RaylibAudioParam(0);
  readonly orientationY = new RaylibAudioParam(0);
  readonly orientationZ = new RaylibAudioParam(1);
  panningModel: "equalpower" | "HRTF" = "HRTF";
  distanceModel: "linear" | "inverse" | "exponential" = "inverse";
  refDistance = 1;
  maxDistance = 10_000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;
}

export class RaylibListener {
  readonly positionX = new RaylibAudioParam(0);
  readonly positionY = new RaylibAudioParam(0);
  readonly positionZ = new RaylibAudioParam(0);
  readonly forwardX = new RaylibAudioParam(0);
  readonly forwardY = new RaylibAudioParam(0);
  readonly forwardZ = new RaylibAudioParam(-1);
  readonly upX = new RaylibAudioParam(0);
  readonly upY = new RaylibAudioParam(1);
  readonly upZ = new RaylibAudioParam(0);
}

/** A procedural cue for the initial prototype; decoded WAV/OGG data comes next. */
export type RaylibAudioBuffer = { readonly cue: string; readonly duration: number };

export class RaylibBufferSourceNode extends RaylibAudioNode {
  buffer: RaylibAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  readonly detune = new RaylibAudioParam(0);
  readonly playbackRate = new RaylibAudioParam(1);
  private stopped = false;
  private generation = 0;

  constructor(private readonly context: RaylibAudioContext) { super(); }

  start(_when = 0, _offset = 0, _duration?: number) {
    // THREE.Audio calls `start()` immediately before it connects the source to
    // its panner/gain graph. Defer one microtask so the native bridge observes
    // that completed graph, matching browser scheduling semantics.
    this.stopped = false;
    this.generation++;
    if (this.buffer) queueMicrotask(() => {
      if (!this.stopped) this.context.play(this);
    });
  }

  stop(_when = 0) {
    this.stopped = true;
    this.context.stop(this);
    this.onended?.();
  }

  getGeneration(): number { return this.generation; }
}

export type RaylibPlayback = {
  cue: string;
  gain: number;
  pan: number;
  distance: number;
  playbackRate: number;
};

/**
 * The injectable object passed to `THREE.AudioContext.setContext(...)`.
 * `onPlayback` is the native raylib bridge: it will own sound aliases, loading,
 * and actual `PlaySound` calls, while Three maintains listener/source transforms.
 */
export class RaylibAudioContext {
  readonly destination = new RaylibAudioNode();
  readonly listener = new RaylibListener();
  readonly startedAt = performance.now();
  onPlayback: ((playback: RaylibPlayback) => (() => void) | void) | null = null;
  private readonly nativeStops = new Map<RaylibBufferSourceNode, { generation: number; stop: () => void }>();

  get currentTime(): number { return (performance.now() - this.startedAt) / 1000; }
  createGain(): RaylibGainNode { return new RaylibGainNode(); }
  createPanner(): RaylibPannerNode { return new RaylibPannerNode(); }
  createBufferSource(): RaylibBufferSourceNode { return new RaylibBufferSourceNode(this); }
  createClickBuffer(cue = "key", duration = getCueProfile(cue)[1] / 1000): RaylibAudioBuffer {
    return { cue, duration };
  }

  /** AudioLoader will use this once WAV parsing is added; reject unsupported data explicitly for now. */
  decodeAudioData(_data: ArrayBuffer, _success?: (buffer: RaylibAudioBuffer) => void): Promise<RaylibAudioBuffer> {
    return Promise.reject(new Error("RaylibAudioContext prototype only supports createClickBuffer(); WAV decoding is not wired yet."));
  }

  play(source: RaylibBufferSourceNode): void {
    const generation = source.getGeneration();
    const panner = findOutput<RaylibPannerNode>(source, RaylibPannerNode);
    const gain = findOutput<RaylibGainNode>(panner ?? source, RaylibGainNode);
    const dx = (panner?.positionX.value ?? 0) - this.listener.positionX.value;
    const dy = (panner?.positionY.value ?? 0) - this.listener.positionY.value;
    const dz = (panner?.positionZ.value ?? 0) - this.listener.positionZ.value;
    const distance = Math.hypot(dx, dy, dz);
    const rightX = this.listener.forwardY.value * this.listener.upZ.value - this.listener.forwardZ.value * this.listener.upY.value;
    const rightY = this.listener.forwardZ.value * this.listener.upX.value - this.listener.forwardX.value * this.listener.upZ.value;
    const rightZ = this.listener.forwardX.value * this.listener.upY.value - this.listener.forwardY.value * this.listener.upX.value;
    const lateral = dx * rightX + dy * rightY + dz * rightZ;
    const pan = Math.max(0, Math.min(1, 0.5 + 0.46 * lateral / Math.max(distance, 0.15)));
    const ref = panner?.refDistance ?? 1;
    const rolloff = panner?.rolloffFactor ?? 1;
    const attenuation = 1 / (1 + Math.max(0, distance - ref) * rolloff);
    const nativeStop = this.onPlayback?.({
      cue: source.buffer!.cue,
      gain: (gain?.gain.value ?? 1) * attenuation,
      pan,
      distance,
      playbackRate: source.playbackRate.value * 2 ** (source.detune.value / 1200),
    });
    if (nativeStop) this.nativeStops.set(source, { generation, stop: nativeStop });
    if (!source.loop) setTimeout(() => {
      if (source.getGeneration() !== generation) return;
      this.nativeStops.delete(source);
      source.onended?.();
    }, source.buffer!.duration * 1000);
  }

  stop(source: RaylibBufferSourceNode): void {
    this.nativeStops.get(source)?.stop();
    this.nativeStops.delete(source);
  }
}

/** Native raylib endpoint for a [RaylibAudioContext]. One instance owns the device and voice pools. */
export class RaylibAudioBackend {
  private readonly pools = new Map<string, { source: raylib.Sound; aliases: raylib.Sound[]; cursor: number }>();
  private ownsRaylib = false;
  private ownsDevice = false;

  initialize(context: RaylibAudioContext): void {
    if (!raylib.isRaylibLoaded()) {
      raylib.loadRaylib(getDefaultRaylibPath());
      this.ownsRaylib = true;
    }
    if (!raylib.IsAudioDeviceReady()) {
      raylib.InitAudioDevice();
      this.ownsDevice = true;
    }
    context.onPlayback = (playback) => this.play(playback);
  }

  dispose(context?: RaylibAudioContext): void {
    if (context) context.onPlayback = null;
    for (const { source, aliases } of this.pools.values()) {
      for (const alias of aliases) raylib.H.UnloadSoundAlias(alias);
      raylib.H.UnloadSound(source);
    }
    this.pools.clear();
    if (this.ownsDevice && raylib.IsAudioDeviceReady()) raylib.CloseAudioDevice();
    this.ownsDevice = false;
    if (this.ownsRaylib) raylib.unloadRaylib();
    this.ownsRaylib = false;
  }

  private play(playback: RaylibPlayback): () => void {
    const pool = this.getPool(playback.cue);
    const voices = [pool.source, ...pool.aliases];
    const voice = voices[pool.cursor++ % voices.length]!;
    // Raylib's pan channel order is reversed relative to Three's listener
    // right-vector convention in this WASAPI/SteamVR output path.
    raylib.H.SetSoundPan(voice, 1 - playback.pan);
    raylib.H.SetSoundVolume(voice, Math.max(0, Math.min(1, playback.gain * 0.55)));
    raylib.H.SetSoundPitch(voice, Math.max(0.25, Math.min(4, playback.playbackRate)));
    raylib.H.PlaySound(voice);
    return () => raylib.H.StopSound(voice);
  }

  private getPool(cue: string) {
    const existing = this.pools.get(cue);
    if (existing) return existing;
    const [frequency, durationMs] = getCueProfile(cue);
    const wav = makeClickWav(frequency, durationMs);
    const wave = raylib.H.LoadWaveFromMemory(".wav", Deno.UnsafePointer.of(wav) as Deno.PointerValue<number>, wav.byteLength);
    const source = raylib.H.LoadSoundFromWave(wave);
    raylib.H.UnloadWave(wave);
    const pool = {
      source,
      aliases: Array.from({ length: 7 }, () => raylib.H.LoadSoundAlias(source)),
      cursor: 0,
    };
    this.pools.set(cue, pool);
    return pool;
  }
}

function getDefaultRaylibPath(): string {
  const url = new URL("../../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}

function makeClickWav(frequency: number, durationMs: number): Uint8Array {
  const sampleRate = 44_100;
  const frames = Math.round(sampleRate * durationMs / 1000);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  put(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // A few milliseconds of attack removes the hard discontinuity that reads
    // as a digital snap, while the longer tail stays audible across WASAPI's
    // ~30 ms device period.
    const attack = Math.min(1, t / 0.0035);
    const decay = Math.exp(-t * 48);
    const fade = Math.min(1, Math.max(0, (frames - i) / (sampleRate * 0.008)));
    const sample = (Math.sin(Math.PI * 2 * frequency * t) + 0.22 * Math.sin(Math.PI * 2 * frequency * 2.03 * t)) * decay * fade;
    view.setInt16(44 + i * 2, Math.round(sample * attack * 7_000), true);
  }
  return bytes;
}

function getCueProfile(cue: string): [frequency: number, durationMs: number] {
  if (cue === "enter") return [180, 68];
  if (cue === "backspace") return [145, 58];
  if (cue === "spacebar") return [118, 52];
  return [250, 40];
}

function findOutput<T extends RaylibAudioNode>(node: RaylibAudioNode, type: new (...args: never[]) => T): T | null {
  const seen = new Set<RaylibAudioNode>();
  const visit = (current: RaylibAudioNode): T | null => {
    if (seen.has(current)) return null;
    seen.add(current);
    if (current instanceof type) return current;
    for (const next of current.outputs) {
      const match = visit(next);
      if (match) return match;
    }
    return null;
  };
  return visit(node);
}
