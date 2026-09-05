import "server-only";
import { after } from "next/server";
import * as baserow from "../baserow";
import { createSupabaseManufacturingAdapter } from "./supabase-adapter";
import { compareRows } from "./parity";
import { manufacturingConfig, assertBaserowWriteSource } from "./config";
import { projectProduction, projectQc, type ReviewRow } from "./projections";
function candidate() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!serviceKey) throw new Error("Supabase manufacturing read credentials missing");
  return createSupabaseManufacturingAdapter({url,serviceKey});
}
export async function getOperations() {
  const config=manufacturingConfig();
  if(config.read!=="baserow") throw new Error("Supabase serving remains disabled; verify shadow parity before an approved cutover");
  const result=await baserow.getOperations();
  if(config.shadow && result.source!=="demo") after(async()=>{
    try { const other=await candidate().getOperations();
      console.info("Manufacturing shadow",JSON.stringify({
        operations:compareRows(result.operations,other.operations,"id"),
        production:compareRows(projectProduction(result.operations),projectProduction(other.operations),"key")
      }));
    } catch { console.warn("Manufacturing shadow unavailable; Baserow response unaffected"); }
  });
  return result;
}
export async function getFabricationJobs() {
  if(manufacturingConfig().read!=="baserow") throw new Error("Supabase serving remains disabled; verify shadow parity before an approved cutover");
  const result=await baserow.getFabricationJobs();
  if(manufacturingConfig().shadow && result.source!=="demo") after(async()=>{
    try { console.info("Finishing shadow",JSON.stringify(compareRows(result.jobs,(await candidate().getFabricationJobs()).jobs,"id"))); }
    catch { console.warn("Finishing shadow unavailable; Baserow response unaffected"); }
  });
  return result;
}
function guarded<T extends unknown[],R>(fn:(...args:T)=>R) { return (...args:T):R=>{assertBaserowWriteSource();return fn(...args);}; }
export const applyQuantityAction=guarded(baserow.applyQuantityAction);
export const patchOperation=guarded(baserow.patchOperation);
export const stealOperationClaim=guarded(baserow.stealOperationClaim);
export const updateCamHandoff=guarded(baserow.updateCamHandoff);
export const applyFabricationAction=guarded(baserow.applyFabricationAction);
export const renameMachinistAllocations=guarded(baserow.renameMachinistAllocations);
export const patchRequirementQualityOutcome=guarded(baserow.patchRequirementQualityOutcome);
export const clearPassedRequirementQualityOutcome=guarded(baserow.clearPassedRequirementQualityOutcome);

export function scheduleQualityControlShadow(expected: ReturnType<typeof projectQc>, reviews: ReviewRow[], users: Array<{id:string;name:string}>) {
  if (!manufacturingConfig().shadow) return;
  after(async()=>{try { const actual=projectQc((await candidate().getOperations()).operations,reviews,users);console.info("QC shadow",JSON.stringify(compareRows(expected,actual,"requirementId"))); } catch { console.warn("QC shadow unavailable; Baserow response unaffected"); }});
}
