import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box3 } from 'three';
const directory = process.argv[2];
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const loader = new GLTFLoader();
let count = 0;
for (const mesh of manifest.meshes) {
  const bytes = await readFile(join(directory, mesh.file));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const bounds = new Box3().setFromObject(gltf.scene);
  if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error(`Invalid bounds: ${mesh.file}`);
  gltf.scene.traverse(object => { object.geometry?.dispose(); if (Array.isArray(object.material)) object.material.forEach(m => m.dispose()); else object.material?.dispose(); });
  count++;
}
console.log(`Three.js loaded and checked bounds for ${count} extracted GLBs`);
