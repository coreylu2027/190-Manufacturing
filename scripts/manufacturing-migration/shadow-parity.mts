import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ENTITIES, type RawRow } from "../../lib/manufacturing/model.ts";
import { createSupabaseManufacturingAdapter } from "../../lib/manufacturing/supabase-adapter.ts";
import { projectOperations, projectProduction, projectFinishing, projectQc, withFinishingQc, type ReviewRow } from "../../lib/manufacturing/projections.ts";
import { compareRows, stable } from "../../lib/manufacturing/parity.ts";
import { readBaserowPages } from "./core.mts";
import { isShopName } from "../../lib/profile-name.ts";
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,serviceKey=process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const baserowUrl=(process.env.BASEROW_API_URL??"https://api.baserow.io").replace(/\/$/,"");
const token=process.env.BASEROW_API_TOKEN;
if(!url||!serviceKey||!token) throw new Error("Existing server-side credentials are required");
async function json(url:string,headers:Record<string,string>) {
  const response=await fetch(url,{method:"GET",headers,redirect:"error",signal:AbortSignal.timeout(30_000)});
  if(!response.ok) throw new Error("Shadow read failed ("+response.status+") at "+new URL(url).pathname);
  return response.json();
}
const headers={apikey:serviceKey,Authorization:"Bearer "+serviceKey};
async function baserowRows() {
  const rows:Record<string,RawRow[]>={};
  for(const entity of ENTITIES) {
    rows[entity.name]=(await readBaserowPages(page=>json(baserowUrl+"/api/database/rows/table/"+entity.tableId+"/?user_field_names=true&size=200&page="+page,{Authorization:"Token "+token})))
      .sort((a,b)=>Number(a.order??a.id)-Number(b.order??b.id)||a.id-b.id);
  }
  return rows;
}
async function supabaseRows(table:string) {
  const result:Record<string,unknown>[]=[];
  for(let offset=0;;) {
    const page=await json(url+"/rest/v1/"+table+"?select=*&order=id&limit=500&offset="+offset,headers);
    if(!Array.isArray(page)) throw new Error("Invalid "+table+" page");
    result.push(...page);
    if(page.length<500) return result;
    offset+=page.length;
  }
}
async function readQc() {
  const [reviews,profiles]=await Promise.all([supabaseRows("quality_control"),supabaseRows("profiles")]);
  const names=new Map(profiles.map(p=>[String(p.id),String(p.display_name??"")]));
  const users:Array<{id:string;name:string}>=[];
  for(let page=1;;page++) {
    const auth=await json(url+"/auth/v1/admin/users?per_page=200&page="+page,headers);
    if(!Array.isArray(auth.users)) throw new Error("Invalid auth user page");
    for(const user of auth.users) {
      const metadata=user.user_metadata?.full_name??user.user_metadata?.name??"";
      users.push({id:user.id,name:isShopName(metadata)?metadata:names.get(user.id)||metadata||String(user.email??"No email").split("@")[0]});
    }
    if(auth.users.length<200) break;
  }
  return {reviews:reviews as unknown as ReviewRow[],users};
}
const before=await baserowRows();
const qcBefore=await readQc();
const adapter=createSupabaseManufacturingAdapter({url,serviceKey});
const candidate=await adapter.readRows();
const [after,qcAfter]=await Promise.all([baserowRows(),readQc()]);
const sourceStable=stable(before)===stable(after)&&stable(qcBefore)===stable(qcAfter);
function views(rows:Record<string,RawRow[]>) {
  const operations=projectOperations(rows.operations,rows.requirements,rows.parts);
  return {operations,production:projectProduction(operations),
    finishing:withFinishingQc(projectFinishing(rows.finishing,rows.requirements),qcBefore.reviews,operations),
    qc:projectQc(operations,qcBefore.reviews,qcBefore.users)};
}
const expected=views(before),actual=views(candidate);
const result={
  checked_at:new Date().toISOString(),source_stable_during_comparison:sourceStable,
  rows:Object.fromEntries(ENTITIES.map(entity=>[entity.name,compareRows(before[entity.name],candidate[entity.name],"id")])),
  operations:compareRows(expected.operations,actual.operations,"id"),
  production:compareRows(expected.production,actual.production,"key"),
  finishing:compareRows(expected.finishing,actual.finishing,"id"),
  qc:compareRows(expected.qc,actual.qc,"requirementId"),
  served_source:"baserow",baserow_writes:0,supabase_writes:0
};
const clean=sourceStable&&[...Object.values(result.rows),result.operations,result.production,result.finishing,result.qc].every(r=>r.clean);
const directory=resolve("migration-artifacts","shadow");
await mkdir(directory,{recursive:true});
await writeFile(resolve(directory,result.checked_at.replace(/[:.]/g,"-")+".json"),JSON.stringify({...result,clean},null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({...result,clean},null,2));
if(!clean) process.exitCode=1;
