import * as THREE from "three";
import { RaythreeExtractor } from "../../submodules/raythree/src/extract.ts";
import type { VrcDepthDebugMeshData } from "../environment/vrcDepthDebugStore.ts";
import type { DepthFrameHeader } from "./format.ts";
import {
  applyWorldToTracking,
  cameraWorldPose,
  headWorldPose,
  type WorldToTracking,
} from "./sync.ts";
import { updateDepthSurface } from "./surface.ts";
import { decodeBytesBase64, payloadDepth, type VrcDepthFramePayload } from "./wire.ts";
import { rotateVec, unprojectDepth } from "./sync.ts";
import type { RawDepthFrame } from "./windowDecoder.ts";

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** Direct capture path: all debug geometry is in VRChat world space, independent of HMD sync. */
export function debugFrameFromSource(
  source: VrcDepthFramePayload,
  revision: number,
  buildGeometry = true,
): VrcDepthDebugFrame {
  return debugFrameFromRaw(
    {
      receivedAt: source.receivedAt,
      decodeMs: source.decodeMs,
      header: source.header,
      width: source.width,
      height: source.height,
      depth: payloadDepth(source),
      colors: source.colorBase64 ? decodeBytesBase64(source.colorBase64) : null,
    },
    revision,
    buildGeometry,
  );
}

export function debugFrameFromRaw(
  source: RawDepthFrame,
  revision: number,
  buildGeometry = true,
): VrcDepthDebugFrame {
  const depth = source.depth;
  const points = buildGeometry
    ? unprojectDepth(depth, source.width, source.height, source.header.projection)
    : new Float32Array(0);
  const camera = cameraWorldPose(source.header);
  for (let i = 0; i < points.length / 3; i++) {
    const p = rotateVec(camera.quaternion, [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]);
    for (let axis = 0; axis < 3; axis++) points[i * 3 + axis] = p[axis] + camera.position[axis];
  }
  let colors: Float32Array | null = null;
  if (buildGeometry && source.colors) {
    const rgba = source.colors;
    colors = new Float32Array(depth.length * 3);
    for (let i = 0; i < depth.length; i++) {
      for (let c = 0; c < 3; c++) {
        colors[i * 3 + c] = rgba[i * 4 + 3] ? LINEAR[rgba[i * 4 + c]] : NaN;
      }
    }
  }
  return {
    receivedAt: source.receivedAt,
    decodedAt: source.decodedAt,
    foreground: source.foreground,
    foregroundBlock: source.foregroundBlock,
    header: source.header,
    alignment: { yawRad: 0, scale: 1, translation: [0, 0, 0] },
    mesh: {
      positions: points,
      depth,
      colors,
      width: source.width,
      height: source.height,
      revision,
    },
  };
}

export type VrcDepthDebugFrame = {
  foreground?: import("./windowDecoder.ts").DepthPlane;
  foregroundBlock?: import("./foreground.ts").DepthForegroundBlock;
  decodedAt?: number;
  receivedAt: number;
  header: DepthFrameHeader;
  alignment: WorldToTracking;
  mesh: VrcDepthDebugMeshData;
};

/** Local debug scene: continuous depth and a head/facing marker, independent of headset visibility. */
export class VrcDepthDebugView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.03, 500);
  readonly extractor = new RaythreeExtractor();
  readonly geometry = new THREE.BufferGeometry();
  readonly surface = new THREE.Mesh(
    this.geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  readonly head = new THREE.Group();
  shading: "color" | "depth" = "depth";
  private revision = -1;
  private previousShading = this.shading;

  constructor() {
    this.surface.frustumCulled = false;
    this.scene.add(this.surface, this.head);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff50c8,
      depthTest: false,
      depthWrite: false,
    });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.20, 0.16), material);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.18), material);
    nose.position.z = -0.14;
    for (const mesh of [head, nose]) {
      mesh.renderOrder = 100;
      this.head.add(mesh);
    }
  }

  update(frame: VrcDepthDebugFrame, aspect: number) {
    if (this.revision !== frame.mesh.revision || this.shading !== this.previousShading) {
      updateDepthSurface(this.geometry, frame.mesh, this.shading);
      this.revision = frame.mesh.revision;
      this.previousShading = this.shading;
    }
    // One presentation clock, moving or stationary: use the pose that produced these pixels.
    const cameraWorld = cameraWorldPose(frame.header);
    const camera = applyWorldToTracking(frame.alignment, cameraWorld);
    this.camera.position.fromArray(camera.position);
    this.camera.quaternion.fromArray(camera.quaternion);
    this.camera.fov = 2 * Math.atan(1 / Math.abs(frame.header.projection.m11)) * 180 / Math.PI;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    const head = applyWorldToTracking(frame.alignment, headWorldPose(frame.header));
    this.head.position.fromArray(head.position);
    this.head.quaternion.fromArray(head.quaternion);
    return this.extractor.extract(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (!Array.isArray(object.material)) object.material.dispose();
      }
    });
  }
}
