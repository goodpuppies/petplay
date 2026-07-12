import React from "react";
// @deno-types="@types/three/webgpu"
import * as THREE from "three/webgpu";
import { useThree } from "@react-three/fiber/webgpu";
import { RaylibAudioBackend, RaylibAudioContext } from "./raylibAudioContext.ts";

export type SpatialAudio = {
  playAtObject: (
    cue: string,
    source: THREE.Object3D | null | undefined,
    worldPoint?: readonly [number, number, number],
  ) => void;
};

const SpatialAudioContext = React.createContext<SpatialAudio | null>(null);
const VOICE_COUNT = 8;

type Voice = { anchor: THREE.Object3D; sound: THREE.PositionalAudio };

class ThreeRaylibSpatialAudio implements SpatialAudio {
  private readonly context = new RaylibAudioContext();
  private readonly backend = new RaylibAudioBackend();
  private listener: THREE.AudioListener | null = null;
  private leases = 0;
  private getCamera: (() => THREE.Camera) | null = null;
  private getScene: (() => THREE.Scene) | null = null;
  private voices: Voice[] = [];
  private nextVoice = 0;

  acquire(getCamera: () => THREE.Camera, getScene: () => THREE.Scene): void {
    this.leases++;
    this.getCamera = getCamera;
    this.getScene = getScene;
    if (this.leases !== 1) return;
    THREE.AudioContext.setContext(this.context as never);
    this.backend.initialize(this.context);
    // AudioListener calls THREE.AudioContext.getContext() in its constructor,
    // so it must be created only after our native context is injected.
    const listener = this.listener = new THREE.AudioListener();
    const scene = getScene();
    this.voices = Array.from({ length: VOICE_COUNT }, () => {
      const anchor = new THREE.Object3D();
      const sound = new THREE.PositionalAudio(listener);
      sound.setRefDistance(0.15);
      sound.setRolloffFactor(0.35);
      sound.setVolume(2.2);
      anchor.add(sound);
      scene.add(anchor);
      return { anchor, sound };
    });
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1);
    if (this.leases !== 0) return;
    this.listener?.parent?.remove(this.listener);
    const scene = this.getScene?.();
    for (const { anchor, sound } of this.voices) {
      sound.stop();
      anchor.remove(sound);
      scene?.remove(anchor);
    }
    this.voices = [];
    this.nextVoice = 0;
    this.listener = null;
    this.backend.dispose(this.context);
    this.getCamera = null;
  }

  playAtObject(
    cue: string,
    source: THREE.Object3D | null | undefined,
    worldPoint?: readonly [number, number, number],
  ): void {
    const camera = this.getCamera?.();
    const scene = this.getScene?.();
    const listener = this.listener;
    if (!source || !camera || !scene || !listener || this.voices.length === 0) return;

    // The active XR camera is the listener. Re-parenting also handles a
    // transition between desktop preview and immersive XR.
    if (listener.parent !== camera) {
      listener.parent?.remove(listener);
      camera.add(listener);
    }

    const voice = this.voices[this.nextVoice++ % this.voices.length]!;
    const { anchor, sound } = voice;
    if (sound.isPlaying) sound.stop();
    if (worldPoint) {
      anchor.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
      anchor.quaternion.identity();
    } else {
      source.updateWorldMatrix(true, false);
      source.getWorldPosition(anchor.position);
      source.getWorldQuaternion(anchor.quaternion);
    }
    sound.setBuffer(this.context.createClickBuffer(cue) as never);
    sound.play();

    // Three only writes positional parameters after playback starts. The
    // normal R3F frame loop keeps these current for longer sounds; this gives
    // short keyboard cues their correct source position immediately.
    // `scene.updateWorldMatrix(..., false)` leaves pooled anchor children
    // stale. Update the exact source and listener trees synchronously so the
    // panner sees this press's transform, not a prior R3F frame.
    camera.updateWorldMatrix(true, true);
    anchor.updateWorldMatrix(true, true);
    listener.updateMatrixWorld(true);
    sound.updateMatrixWorld(true);
  }
}

const nativeAudio = new ThreeRaylibSpatialAudio();

/** Native Web-Audio-compatible context for Three/Drei positional sources. */
export function SpatialAudioProvider({ children }: { children: React.ReactNode }) {
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  React.useEffect(() => {
    nativeAudio.acquire(() => {
      const xr = (renderer as unknown as {
        xr?: { isPresenting?: boolean; getCamera?: () => THREE.Camera };
      }).xr;
      return xr?.isPresenting && xr.getCamera ? xr.getCamera() : camera;
    }, () => scene);
    return () => nativeAudio.release();
  }, [camera, renderer, scene]);

  return <SpatialAudioContext.Provider value={nativeAudio}>{children}</SpatialAudioContext.Provider>;
}

export function useSpatialAudio(): SpatialAudio | null {
  return React.useContext(SpatialAudioContext);
}
