import { actorState, PostMan } from "../../submodules/stageforge/mod.ts";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";

type ReproMode = "library" | "window" | "render-texture" | "rlgl" | "mesh";

const mode = getMode();
const state = actorState({
  name: "raylib_reload_repro",
  windowInitialized: false,
  target: null as raylib.RenderTexture2D | null,
  mesh: null as raylib.Mesh | null,
});

new PostMan(state, {
  __INIT__: () => {
    console.log(`[raylib-repro] init mode=${mode}`);
    raylib.loadRaylib(getRaylibPath());
    console.log("[raylib-repro] library loaded");

    if (mode !== "library") {
      raylib.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
      raylib.H.InitWindow(1, 1, `raylib_reload_repro_${crypto.randomUUID()}`);
      state.windowInitialized = true;
      console.log("[raylib-repro] hidden window initialized");
    }

    if (mode === "render-texture" || mode === "rlgl") {
      state.target = raylib.H.LoadRenderTexture(64, 64);
      console.log(
        `[raylib-repro] render texture loaded id=${state.target.texture.id}`,
      );
    }

    if (mode === "rlgl") {
      raylib.getRaylibSymbols().rlColorMask(true, true, true, true);
      console.log("[raylib-repro] rlgl symbol called through primary library");
    }

    if (mode === "mesh") {
      state.mesh = uploadTriangleMesh();
      console.log(`[raylib-repro] mesh uploaded vao=${state.mesh.vaoId}`);
    }
  },
  __HEALTH__: () => ({
    mode,
    windowInitialized: state.windowInitialized,
    target: state.target != null,
    mesh: state.mesh != null,
  }),
  __SHUTDOWN__: () => {
    console.log("[raylib-repro] shutdown begin");
    if (state.mesh !== null) {
      unloadUploadedMeshGpuOnly(state.mesh);
      state.mesh = null;
      console.log("[raylib-repro] mesh unloaded");
    }
    if (state.target !== null) {
      raylib.H.UnloadRenderTexture(state.target);
      state.target = null;
      console.log("[raylib-repro] render texture unloaded");
    }
    if (state.windowInitialized) {
      raylib.CloseWindow();
      state.windowInitialized = false;
      console.log("[raylib-repro] window closed");
    }
    raylib.unloadRaylib();
    console.log("[raylib-repro] library closed; shutdown hook returning");
  },
});

function getMode(): ReproMode {
  const raw = Deno.args.find((arg) => arg.startsWith("--mode="))?.split(
    "=",
    2,
  )[1];
  if (
    raw === "library" || raw === "window" || raw === "render-texture" ||
    raw === "rlgl" ||
    raw === "mesh"
  ) {
    return raw;
  }
  return "rlgl";
}

function uploadTriangleMesh(): raylib.Mesh {
  const vertices = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
  const verticesPointer = Deno.UnsafePointer.of(vertices);
  const meshHandle = raylib.Mesh.createPointer({
    vertexCount: 3,
    triangleCount: 1,
    vertices: verticesPointer === null ? 0n : Deno.UnsafePointer.value(verticesPointer),
    texcoords: 0n,
    texcoords2: 0n,
    normals: 0n,
    tangents: 0n,
    colors: 0n,
    indices: 0n,
    animVertices: 0n,
    animNormals: 0n,
    boneIds: 0n,
    boneWeights: 0n,
    boneMatrices: 0n,
    boneCount: 0,
    vaoId: 0,
    vboId: 0n,
  } as unknown as raylib.Mesh);
  raylib.H.UploadMesh(meshHandle.pointer, false);
  const uploaded = meshHandle.read();
  return { ...uploaded, vertices: 0n } as unknown as raylib.Mesh;
}

function unloadUploadedMeshGpuOnly(mesh: raylib.Mesh): void {
  const symbols = raylib.getRaylibSymbols();
  if (mesh.vaoId > 0) symbols.rlUnloadVertexArray(mesh.vaoId);
  if (typeof mesh.vboId !== "bigint" || mesh.vboId === 0n) return;
  const pointer = Deno.UnsafePointer.create(mesh.vboId);
  if (pointer === null) return;
  const view = new Deno.UnsafePointerView(pointer);
  for (let index = 0; index < 7; index++) {
    const id = view.getUint32(index * 4);
    if (id > 0) symbols.rlUnloadVertexBuffer(id);
  }
  raylib.H.MemFree(pointer);
}

function getRaylibPath(): string {
  const url = new URL("../../resources/raylib.dll", import.meta.url);
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\/+/, ""))
    : decodeURIComponent(url.pathname);
}
