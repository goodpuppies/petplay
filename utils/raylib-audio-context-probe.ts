import { RaylibAudioBackend, RaylibAudioContext } from "../classes/environment/raylibAudioContext.ts";
import * as THREE from "three/webgpu";

const context = new RaylibAudioContext();
const backend = new RaylibAudioBackend();
backend.initialize(context);

try {
  THREE.AudioContext.setContext(context as never);
  const camera = new THREE.PerspectiveCamera();
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const beacon = new THREE.Object3D() as unknown as THREE.Object3D & { position: THREE.Vector3 };
  const world = new THREE.Scene();
  world.add(camera, beacon);
  const buffer = context.createClickBuffer("enter", 0.14);

  console.log("audio probe: Three PositionalAudio orbiting the listener for 6 seconds");
  for (let step = 0; step < 48; step++) {
    const angle = step / 48 * Math.PI * 2;
    beacon.position.set(Math.sin(angle) * 1.2, 0, -Math.cos(angle) * 1.2);
    const sound = new THREE.PositionalAudio(listener);
    sound.setBuffer(buffer as never);
    sound.setRefDistance(0.15);
    sound.setRolloffFactor(0.35);
    beacon.add(sound);
    sound.play();
    // PositionalAudio only pushes its Object3D transform into the panner while
    // playing, so this must occur after `play()` (normal R3F frames do this).
    world.updateMatrixWorld(true);
    setTimeout(() => beacon.remove(sound), 180);
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
} finally {
  backend.dispose(context);
}
