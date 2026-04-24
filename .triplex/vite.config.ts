import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const triplexRendererRequire = createRequire(
  "file:///C:/GIT/triplex/packages/renderer/package.json",
);

export default {
  optimizeDeps: {
    entries: [],
    include: [
      "@react-three/fiber/webgpu",
      "camera-controls",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "tinycolor2",
      "triplex-drei",
      "triplex-handle",
      "zustand",
      "zustand/vanilla",
      "zustand/traditional",
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@react-three\/fiber$/,
        replacement: resolve(
          root,
          ".triplex/r3f-webgpu-compat.ts",
        ),
      },
      {
        find: "camera-controls",
        replacement: triplexRendererRequire.resolve("camera-controls"),
      },
      {
        find: "tinycolor2",
        replacement: triplexRendererRequire.resolve("tinycolor2"),
      },
      {
        find: "triplex-drei",
        replacement: triplexRendererRequire.resolve("triplex-drei"),
      },
      {
        find: "triplex-handle",
        replacement: triplexRendererRequire.resolve("triplex-handle"),
      },
      {
        find: "@react-three/handle",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/xr/packages/react/handle/src/index.ts",
        ),
      },
      {
        find: "@pmndrs/xr",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/xr/packages/react/xr/src/index.ts",
        ),
      },
      {
        find: "@pmndrs/handle",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/xr/packages/handle/src/index.ts",
        ),
      },
      {
        find: "@pmndrs/pointer-events",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/xr/packages/pointer-events/src/index.ts",
        ),
      },
      {
        find: "three/webgpu",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/three.js/build/three.webgpu.js",
        ),
      },
      {
        find: "three/tsl",
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/three.js/build/three.tsl.js",
        ),
      },
      {
        find: /^three\/src\/(.*)$/,
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/three.js/src/$1",
        ),
      },
      {
        find: /^three\/addons\/(.*)$/,
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/three.js/examples/jsm/$1",
        ),
      },
      {
        find: /^three$/,
        replacement: resolve(
          root,
          "submodules/threewebxrwebgpudeno/submodules/three.js/build/three.module.js",
        ),
      },
    ],
  },
};
