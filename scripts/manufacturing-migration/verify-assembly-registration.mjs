import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
const directory = process.argv[2];
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const requirements = JSON.parse(await readFile(join(directory, 'requirements.json'), 'utf8'));
for (let i = 0; i < requirements.length; i += 5) {
  await Promise.all(requirements.slice(i, i + 5).map(async r => {
    const { data, error } = await client.rpc('manufacturing_preview_for_requirement', { p_requirement_id: r.requirement_id });
    if (error || data?.sha256 !== r.sha256) throw new Error(`Preview lookup failed for requirement ${r.requirement_id}: ${error?.message ?? 'hash mismatch'}`);
  }));
}
for (const status of ['existing', 'matched']) {
  const p = manifest.parts.find(p => p.status === status);
  const { data, error } = await client.rpc('manufacturing_register_assembly_preview', {
    p_part_id: p.id, p_matched_name: p.name, p_source_name: manifest.source_name,
    p_source_sha256: manifest.source_sha256, p_source_mesh_index: 0,
    p_byte_size: 1, p_sha256: '0'.repeat(64), p_verified_at: new Date().toISOString(),
  });
  if (error || data !== false) throw new Error(`Overwrite guard failed for ${status}: ${error?.message}`);
}
console.log(`Verified ${requirements.length} requirement preview lookups and both overwrite guards`);
