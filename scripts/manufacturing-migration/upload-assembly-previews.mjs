import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readGlb, sha256 } from './assembly-glb.mjs';

const [directory, flag] = process.argv.slice(2);
if (!directory || flag !== '--apply') throw new Error('Usage: node --env-file=.env.local upload-assembly-previews.mjs directory --apply');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const project = (await readFile('supabase/.temp/project-ref', 'utf8')).trim();
if (!url || !key || new URL(url).hostname !== `${project}.supabase.co`) throw new Error('Missing or mismatched Supabase configuration');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
async function rpc(name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}
const bucket = 'manufacturing-files';
const { data: info, error: bucketError } = await client.storage.getBucket(bucket);
if (bucketError || !info || info.public) throw new Error('Private preview bucket unavailable');
const before = await rpc('manufacturing_preview_manifest');
const inventory = await rpc('manufacturing_assembly_preview_inventory');
await writeFile(join(directory, 'existing-previews-before.json'), JSON.stringify(before, null, 2));
const results = [];
for (const part of manifest.parts.filter(p => p.status === 'matched')) {
  const current = inventory.find(p => p.id === part.id);
  if (!current || current.name !== part.name || current.part_number !== part.part_number) throw new Error(`Part identity changed: ${part.id}`);
  if (current.has_preview) { results.push({ part_id: part.id, status: 'existing' }); continue; }
  const mesh = manifest.meshes.find(m => m.index === part.meshes[0]);
  if (!mesh || mesh.file !== `mesh-${mesh.index}.glb`) throw new Error('Invalid mesh manifest');
  const bytes = await readFile(join(directory, mesh.file));
  readGlb(bytes);
  if (bytes.length !== mesh.byte_size || sha256(bytes) !== mesh.sha256) throw new Error('Local GLB integrity failure');
  const path = `sha256/${mesh.sha256.slice(0, 2)}/${mesh.sha256}.glb`;
  let { data: stored } = await client.storage.from(bucket).download(path);
  if (!stored) {
    const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType: 'model/gltf-binary', upsert: false });
    if (error && !['409', '400'].includes(String(error.statusCode))) throw new Error(`Upload failed: ${error.message}`);
    const verified = await client.storage.from(bucket).download(path);
    if (verified.error || !verified.data) throw new Error(`Cannot verify uploaded GLB: ${verified.error?.message}`);
    stored = verified.data;
  }
  if (stored.size !== bytes.length || sha256(Buffer.from(await stored.arrayBuffer())) !== mesh.sha256) throw new Error('Stored GLB integrity failure; existing object will not be overwritten');
  const inserted = await rpc('manufacturing_register_assembly_preview', {
    p_part_id: part.id, p_matched_name: part.name, p_source_name: manifest.source_name,
    p_source_sha256: manifest.source_sha256, p_source_mesh_index: mesh.index,
    p_byte_size: bytes.length, p_sha256: mesh.sha256, p_verified_at: new Date().toISOString(),
  });
  results.push({ part_id: part.id, part_number: part.part_number, status: inserted ? 'added' : 'existing', sha256: mesh.sha256 });
  await writeFile(join(directory, 'upload-results.json'), JSON.stringify(results, null, 2));
  console.log(`${part.part_number}: ${inserted ? 'added and verified' : 'existing preview preserved'}`);
}
const after = await rpc('manufacturing_preview_manifest');
for (const original of before) {
  if (JSON.stringify(after.find(p => p.part_id === original.part_id)) !== JSON.stringify(original)) throw new Error(`Existing preview metadata changed: ${original.part_id}`);
}
const finalInventory = await rpc('manufacturing_assembly_preview_inventory');
if (results.some(r => !finalInventory.find(p => p.id === r.part_id)?.has_preview)) throw new Error('Final preview inventory verification failed');
console.log(JSON.stringify({ added: results.filter(r => r.status === 'added').length, existing_preserved: before.length, total_with_previews: finalInventory.filter(p => p.has_preview).length }));
