// PetPlay renders through WebGPU (three's WebGPURenderer, or raythree standing in for it), never
// WebGL. Registering that makes r3f type `state.gl` as the WebGPURenderer it is at runtime;
// unregistered, r3f v10 types it as a WebGLRenderer.
import type {} from "npm:@react-three/fiber@10.0.0-alpha.6/webgpu";

declare module "npm:@react-three/fiber@10.0.0-alpha.6/webgpu" {
  interface Register {
    renderer: "webgpu";
  }
}
