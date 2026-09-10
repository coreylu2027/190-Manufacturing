import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function readGlb(bytes) {
  if (bytes.length < 28 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Invalid GLB');
  const end = 20 + bytes.readUInt32LE(12);
  if (end + 8 > bytes.length || bytes.readUInt32LE(end + 4) !== 0x004e4942 || end + 8 + bytes.readUInt32LE(end) !== bytes.length) throw new Error('Invalid binary chunk');
  const doc = JSON.parse(bytes.subarray(20, end).toString());
  if (doc.buffers?.length !== 1 || doc.buffers[0].uri || doc.extensionsRequired?.length || doc.textures?.length || doc.animations?.length || doc.skins?.length) throw new Error('Unsupported GLB features');
  return { doc, binary: bytes.subarray(end + 8) };
}

// Copy only referenced geometry; retain exact accessor bytes and original materials.
// Assembly occurrence transforms are intentionally omitted for isolated body previews.
export function extractMesh(source, meshIndex, name) {
  const { doc, binary } = source;
  const mesh = structuredClone(doc.meshes[meshIndex]);
  if (!mesh?.primitives?.length || mesh.weights) throw new Error('Invalid mesh');
  const accessors = [], bufferViews = [], materials = [], chunks = [];
  const accessorMap = new Map(), viewMap = new Map(), materialMap = new Map();
  let size = 0;
  const copyView = id => {
    if (viewMap.has(id)) return viewMap.get(id);
    const v = doc.bufferViews[id];
    if (!v || v.buffer !== 0 || v.extensions || !Number.isSafeInteger(v.byteLength) || v.byteLength <= 0 || (v.byteOffset ?? 0) < 0 || (v.byteOffset ?? 0) + v.byteLength > binary.length) throw new Error('Invalid buffer view');
    const index = bufferViews.length;
    viewMap.set(id, index);
    const padding = (4 - size % 4) % 4;
    chunks.push(Buffer.alloc(padding)); size += padding;
    bufferViews.push({ ...v, buffer: 0, byteOffset: size });
    chunks.push(binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); size += v.byteLength;
    return index;
  };
  const copyAccessor = id => {
    if (accessorMap.has(id)) return accessorMap.get(id);
    const a = doc.accessors[id];
    if (!a || a.sparse || a.extensions || a.bufferView === undefined) throw new Error('Unsupported accessor');
    const index = accessors.length;
    accessorMap.set(id, index);
    accessors.push({ ...a, bufferView: copyView(a.bufferView) });
    return index;
  };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.primitives) {
    if (p.targets || p.extensions || (p.mode !== undefined && p.mode !== 4)) throw new Error('Unsupported primitive');
    const position = doc.accessors[p.attributes.POSITION];
    if (position?.type !== 'VEC3' || !position.min || !position.max) throw new Error('Missing position bounds');
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], position.min[i]); max[i] = Math.max(max[i], position.max[i]); }
    for (const key of Object.keys(p.attributes)) p.attributes[key] = copyAccessor(p.attributes[key]);
    if (p.indices !== undefined) p.indices = copyAccessor(p.indices);
    if (p.material !== undefined) {
      if (!materialMap.has(p.material)) { materialMap.set(p.material, materials.length); materials.push(structuredClone(doc.materials[p.material])); }
      p.material = materialMap.get(p.material);
    }
  }
  if (![...min, ...max].every(Number.isFinite) || !max.some((v, i) => v > min[i])) throw new Error('Empty bounds');
  chunks.push(Buffer.alloc((4 - size % 4) % 4));
  const bin = Buffer.concat(chunks);
  const out = { asset: { version: '2.0', generator: 'FRC190 assembly GLB extractor v1' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name, translation: min.map((v, i) => -(v + max[i]) / 2) }],
    meshes: [{ ...mesh, name }], accessors, bufferViews, materials, buffers: [{ byteLength: bin.length }] };
  const json = Buffer.from(JSON.stringify(out));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + bin.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
  const result = Buffer.concat([header, padded, binHeader, bin]); readGlb(result);
  return result;
}

export function matchParts(parts, doc) {
  return parts.map(part => {
    const nodes = doc.nodes.map((n, index) => ({ ...n, index })).filter(n => part.name && n.name === part.name && n.mesh !== undefined);
    const meshes = [...new Set(nodes.map(n => n.mesh))];
    const duplicate = parts.filter(p => p.name === part.name).length > 1;
    const transformed = nodes.some(n => n.matrix || n.translation || n.rotation || n.scale);
    const status = part.has_preview ? 'existing' : !meshes.length ? 'unmatched' : duplicate || meshes.length !== 1 || transformed ? 'ambiguous' : 'matched';
    return { ...part, status, meshes, node_indices: nodes.map(n => n.index) };
  });
}
