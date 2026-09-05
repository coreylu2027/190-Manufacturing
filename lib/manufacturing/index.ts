import "server-only";
import { after } from "next/server";
import * as baserow from "../baserow";
import { createSupabaseManufacturingAdapter } from "./supabase-adapter";
import { compareRows } from "./parity";
import { manufacturingConfig, assertBaserowWriteSource } from "./config";
import { createSupabaseWriteAdapter } from "./write-adapter";
import { projectProduction, projectQc, type ReviewRow } from "./projections";
function candidate() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url||!serviceKey) throw new Error("Supabase manufacturing read credentials missing");
  return createSupabaseManufacturingAdapter({url,serviceKey});
}
export async function getOperations() {
  const config=manufacturingConfig();
  if(config.read==="supabase") return candidate().getOperations();
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
  if(manufacturingConfig().read==="supabase") return candidate().getFabricationJobs();
  const result=await baserow.getFabricationJobs();
  if(manufacturingConfig().shadow && result.source!=="demo") after(async()=>{
    try { console.info("Finishing shadow",JSON.stringify(compareRows(result.jobs,(await candidate().getFabricationJobs()).jobs,"id"))); }
    catch { console.warn("Finishing shadow unavailable; Baserow response unaffected"); }
  });
  return result;
}
function writer() {
  const config = manufacturingConfig();
  if (config.write === "baserow") return null;
  if (config.read !== "supabase") throw new Error("Mixed manufacturing sources are disabled; a coordinated cutover is required");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Supabase manufacturing write credentials missing");
  return createSupabaseWriteAdapter({ url, serviceKey });
}
export async function applyQuantityAction(...args: Parameters<typeof baserow.applyQuantityAction>) {
  return (writer() ?? baserow).applyQuantityAction(...args);
}
export async function stealOperationClaim(...args: Parameters<typeof baserow.stealOperationClaim>) {
  return (writer() ?? baserow).stealOperationClaim(...args);
}
export async function patchOperation(id: number, patch: Parameters<typeof baserow.patchOperation>[1], name: string, actorId?: string) {
  const adapter = writer();
  return adapter ? adapter.patchOperation(id, patch, { id: actorId ?? "", name }) : baserow.patchOperation(id, patch, name);
}
export async function updateCamHandoff(id: number, patch: Parameters<typeof baserow.updateCamHandoff>[1], actor?: { id: string; name: string }) {
  const adapter = writer();
  return adapter ? adapter.updateCamHandoff(id, patch, actor ?? { id: "", name: "" }) : baserow.updateCamHandoff(id, patch);
}
export async function applyFabricationAction(id: number, action: Parameters<typeof baserow.applyFabricationAction>[1], actor: { id?: string; name: string }) {
  const adapter = writer();
  return adapter ? adapter.applyFabricationAction(id, action, { ...actor, id: actor.id ?? "" }) : baserow.applyFabricationAction(id, action, actor);
}
export async function renameMachinistAllocations(...args: Parameters<typeof baserow.renameMachinistAllocations>) {
  return (writer() ?? baserow).renameMachinistAllocations(...args);
}
export async function recordQualityReview(requirementId: number, result: "passed" | "failed", notes: string, actor: { id: string; name: string }) {
  const adapter = writer();
  if (!adapter) throw new Error("Atomic QC is only available with Supabase writes");
  return adapter.recordQualityReview(requirementId, result, notes, actor);
}
export async function undoQualityReview(requirementId: number, actor: { id: string; name: string }) {
  const adapter = writer();
  if (!adapter) throw new Error("Atomic QC is only available with Supabase writes");
  return adapter.undoQualityReview(requirementId, actor);
}
export async function getRetractedQualityReviewIds(): Promise<number[]> {
  return writer()?.retractedReviewIds() ?? [];
}
// These mirrors are only used by the unchanged Baserow QC path. Supabase QC
// must always record the review and workflow change in a single transaction.
function guarded<T extends unknown[],R>(fn:(...args:T)=>R) { return (...args:T):R=>{assertBaserowWriteSource();return fn(...args);}; }
export const patchRequirementQualityOutcome=guarded(baserow.patchRequirementQualityOutcome);
export const clearPassedRequirementQualityOutcome=guarded(baserow.clearPassedRequirementQualityOutcome);

export function scheduleQualityControlShadow(expected: ReturnType<typeof projectQc>, reviews: ReviewRow[], users: Array<{id:string;name:string}>) {
  if (!manufacturingConfig().shadow) return;
  after(async()=>{try { const actual=projectQc((await candidate().getOperations()).operations,reviews,users);console.info("QC shadow",JSON.stringify(compareRows(expected,actual,"requirementId"))); } catch { console.warn("QC shadow unavailable; Baserow response unaffected"); }});
}
