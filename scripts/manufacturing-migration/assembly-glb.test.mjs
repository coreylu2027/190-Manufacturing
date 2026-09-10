import test from 'node:test';
import assert from 'node:assert/strict';
import { readGlb, extractMesh, matchParts } from './assembly-glb.mjs';
import { cadMeshesToGlb } from '../../lib/manufacturing/glb.mts';

test('extraction retains geometry bytes and materials, drops other meshes, and centers bounds', () => {
  const mesh = { name: 'sample', attributes: { position: { array: [10, 20, 30, 12, 20, 30, 10, 24, 30] } }, index: { array: [0, 1, 2] }, color: [1, 0, 0] };
  const source = readGlb(Buffer.from(cadMeshesToGlb({ success: true, meshes: [mesh, mesh] })));
  const result = readGlb(extractMesh(source, 1, 'isolated'));
  assert.equal(result.doc.meshes.length, 1);
  assert.equal(result.doc.nodes.length, 1);
  assert.deepEqual(result.doc.materials[0], source.doc.materials[1]);
  const sourceAccessor = source.doc.accessors[source.doc.meshes[1].primitives[0].attributes.POSITION];
  const resultAccessor = result.doc.accessors[result.doc.meshes[0].primitives[0].attributes.POSITION];
  const a = source.doc.bufferViews[sourceAccessor.bufferView], b = result.doc.bufferViews[resultAccessor.bufferView];
  assert.deepEqual(result.binary.subarray(b.byteOffset, b.byteOffset + b.byteLength), source.binary.subarray(a.byteOffset, a.byteOffset + a.byteLength));
  assert.deepEqual(result.doc.nodes[0].translation, sourceAccessor.min.map((v, i) => -(v + sourceAccessor.max[i]) / 2));
  assert.ok(result.binary.length < source.binary.length);
});

test('matching skips existing previews, duplicate names, multiple meshes and transformed bodies', () => {
  const parts = [{ id: 1, name: 'a', has_preview: true }, { id: 2, name: 'b' }, { id: 3, name: 'c' }, { id: 4, name: 'c' }, { id: 5, name: 'd' }, { id: 6, name: null }, { id: 7, name: 'e' }];
  const doc = { nodes: [{ name: 'a', mesh: 0 }, { name: 'b', mesh: 1 }, { name: 'b', mesh: 1 }, { name: 'c', mesh: 2 }, { name: 'd', mesh: 3 }, { name: 'd', mesh: 4 }, { name: 'e', mesh: 5, scale: [1, 1, 1] }] };
  assert.deepEqual(matchParts(parts, doc).map(p => p.status), ['existing', 'matched', 'ambiguous', 'ambiguous', 'ambiguous', 'unmatched', 'ambiguous']);
});

test('rejects incomplete GLBs', () => assert.throws(() => readGlb(Buffer.alloc(28)), /Invalid GLB/));
