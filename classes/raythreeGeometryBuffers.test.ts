import { assertEquals } from "@std/assert";
import { prepareGeometryBuffers } from "./webxrRaythreeRaylibRenderer.ts";
import type { GeometryAsset } from "../submodules/raythree/src/ir.ts";

function geometry(count: number, indices: number[]): GeometryAsset {
  return {
    id: 1,
    revision: 1,
    topology: "triangles",
    attributes: {
      position: {
        itemSize: 3,
        count,
        componentType: "Float32Array",
        normalized: false,
        array: Float32Array.from({ length: count * 3 }, (_, i) => i),
      },
    },
    index: {
      count: indices.length,
      componentType: "Uint32Array",
      array: Uint32Array.from(indices),
    },
  };
}

Deno.test("raylib preserves shared vertices and safely narrows small indices", () => {
  const result = prepareGeometryBuffers(geometry(4, [0, 1, 2, 1, 3, 2]))!;
  assertEquals(result.vertexCount, 4);
  assertEquals(result.triangleCount, 2);
  assertEquals(result.vertices.length, 12);
  assertEquals(result.indices, new Uint16Array([0, 1, 2, 1, 3, 2]));
});

Deno.test("raylib expands large indices without truncating them", () => {
  const result = prepareGeometryBuffers(geometry(65537, [65536, 2, 1]))!;
  assertEquals(result.vertexCount, 3);
  assertEquals(result.indices, null);
  assertEquals(Array.from(result.vertices.slice(0, 3)), [196608, 196609, 196610]);
});
