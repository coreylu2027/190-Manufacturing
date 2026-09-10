import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readGlb, extractMesh, matchParts, sha256 } from './assembly-glb.mjs';

const [input, inventory, output] = process.argv.slice(2);
if (!input || !inventory || !output) throw new Error('Usage: node extract-assembly-previews.mjs robot.glb parts.json output-directory');
const bytes = await readFile(input);
const source = readGlb(bytes);
const parts = JSON.parse(await readFile(inventory, 'utf8'));
const matches = matchParts(parts, source.doc);
await mkdir(output, { recursive: true });
// Export every distinct mesh for later review, including currently unmatched bodies.
const meshes = [];
for (let index = 0; index < source.doc.meshes.length; index++) {
  const names = [...new Set(source.doc.nodes.filter(n => n.mesh === index).map(n => n.name).filter(Boolean))];
  const glb = extractMesh(source, index, names[0] ?? `Mesh ${index}`);
  const file = `mesh-${index}.glb`;
  await writeFile(join(output, file), glb);
  meshes.push({ index, names, file, sha256: sha256(glb), byte_size: glb.length });
}
const manifest = { source_name: basename(input), source_sha256: sha256(bytes), meshes, parts: matches };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const summary = Object.fromEntries(['existing', 'matched', 'ambiguous', 'unmatched'].map(status => [status, matches.filter(p => p.status === status).length]));
await writeFile(join(output, 'review.json'), JSON.stringify(matches.filter(p => ['ambiguous', 'unmatched'].includes(p.status)), null, 2));
console.log(JSON.stringify({ ...summary, extracted_meshes: meshes.length, total_bytes: meshes.reduce((n, m) => n + m.byte_size, 0) }));
