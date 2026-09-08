import assert from "node:assert/strict";
import test from "node:test";

import { cadMeshesToGlb, inspectGlb } from "./glb.mts";

const triangle = {
  success: true,
  meshes: [{
    name: "Bracket",
    color: [0.8, 0.2, 0.1],
    attributes: {
      position: { array: [0, 0, 0, 10, 0, 0, 0, 20, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2] },
  }],
};

test("CAD meshes produce a deterministic, self-contained GLB", () => {
  const first = cadMeshesToGlb(triangle);
  const second = cadMeshesToGlb(triangle);
  assert.deepEqual(first, second);

  const document = inspectGlb(first) as {
    asset: { version: string };
    buffers: Array<{ byteLength: number }>;
    accessors: Array<{ componentType: number; min?: number[]; max?: number[] }>;
    meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; mode: number }> }>;
  };
  assert.equal(document.asset.version, "2.0");
  assert.equal(document.buffers.length, 1);
  assert.deepEqual(document.accessors[0].min, [0, 0, 0]);
  assert.deepEqual(document.accessors[0].max, [10, 20, 0]);
  assert.equal(document.accessors[2].componentType, 5123);
  assert.equal(document.meshes[0].primitives[0].mode, 4);
  assert.deepEqual(document.meshes[0].primitives[0].attributes, { POSITION: 0, NORMAL: 1 });
});

test("CAD conversion rejects unsafe mesh indices", () => {
  assert.throws(() => cadMeshesToGlb({
    success: true,
    meshes: [{
      attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
      index: { array: [0, 1, 4] },
    }],
  }), /out-of-range triangle index/);
});
