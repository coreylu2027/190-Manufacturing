export function stable(value: unknown): string {
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  if(value!==null && typeof value==="object") return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+":"+stable(v)).join(",")+"}";
  return JSON.stringify(value);
}
export function compareRows(expected: readonly unknown[], actual: readonly unknown[], key: string) {
  const asRow=(row:unknown)=>row as Record<string,unknown>;
  const left=new Map(expected.map(r=>[String(asRow(r)[key]),r]));
  const right=new Map(actual.map(r=>[String(asRow(r)[key]),r]));
  if(left.size!==expected.length || right.size!==actual.length) throw new Error("Duplicate parity identity: "+key);
  const missing=[...left.keys()].filter(k=>!right.has(k));
  const extra=[...right.keys()].filter(k=>!left.has(k));
  const changed=[...left.keys()].filter(k=>right.has(k) && stable(left.get(k))!==stable(right.get(k)));
  const fields=Object.fromEntries(changed.slice(0,30).map(k=>{
    const a=asRow(left.get(k)),b=asRow(right.get(k));
    return [k,[...new Set([...Object.keys(a),...Object.keys(b)])].filter(f=>stable(a[f])!==stable(b[f]))];
  }));
  return {clean:!missing.length&&!extra.length&&!changed.length,expected:expected.length,actual:actual.length,missing,extra,changed,fields};
}
