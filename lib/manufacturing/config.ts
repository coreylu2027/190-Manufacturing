export function manufacturingConfig(env: Record<string,string|undefined> = process.env) {
  const read=env.MANUFACTURING_READ_SOURCE ?? "baserow";
  const write=env.MANUFACTURING_WRITE_SOURCE ?? "baserow";
  if(!["baserow","supabase"].includes(read) || !["baserow","supabase"].includes(write)) throw new Error("Invalid manufacturing source configuration");
  return {read,write,shadow:env.MANUFACTURING_SHADOW_READS==="true"};
}
export function assertBaserowWriteSource(env: Record<string,string|undefined> = process.env) {
  if(manufacturingConfig(env).write!=="baserow") throw new Error("Supabase production writes remain disabled pending a separately approved cutover");
}
