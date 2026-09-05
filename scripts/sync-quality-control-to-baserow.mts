interface QualityControlRow {
  id: number;
  production_requirement_id: number | null;
  result: "passed" | "failed";
  notes: string;
  reviewed_by: string;
  reviewed_at: string;
}

interface ProfileRow {
  id: string;
  display_name: string;
}

const apply = process.argv.includes("--apply");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const baserowUrl = (process.env.BASEROW_API_URL ?? "https://api.baserow.io").replace(/\/$/, "");
const baserowToken = process.env.BASEROW_API_TOKEN;
const requirementsTableId = process.env.BASEROW_REQUIREMENTS_TABLE_ID ?? "1119642";

if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase service-role configuration is required");
if (!baserowToken) throw new Error("Baserow API configuration is required");
const supabaseServiceRoleKey = serviceRoleKey;

async function listSupabaseRows<T>(table: string, select: string): Promise<T[]> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${select}`, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Range: "0-9999",
    },
  });
  if (!response.ok) throw new Error(`Unable to read Supabase ${table} (${response.status})`);
  return response.json() as Promise<T[]>;
}

const [reviews, profiles] = await Promise.all([
  listSupabaseRows<QualityControlRow>(
    "quality_control",
    "id,production_requirement_id,result,notes,reviewed_by,reviewed_at",
  ),
  listSupabaseRows<ProfileRow>("profiles", "id,display_name"),
]);

const profilesById = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
const latestByRequirement = new Map<number, QualityControlRow>();
for (const review of reviews) {
  if (!review.production_requirement_id) continue;
  const current = latestByRequirement.get(review.production_requirement_id);
  if (
    !current
    || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()
    || (review.reviewed_at === current.reviewed_at && review.id > current.id)
  ) {
    latestByRequirement.set(review.production_requirement_id, review);
  }
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  reviews: reviews.length,
  requirementsWithReviews: latestByRequirement.size,
  unmappedLegacyReviews: reviews.filter((review) => !review.production_requirement_id).length,
  missingReviewerProfiles: [...latestByRequirement.values()].filter((review) => !profilesById.has(review.reviewed_by)).length,
}, null, 2));

if (!apply) process.exit(0);

for (const [requirementId, review] of latestByRequirement) {
  const response = await fetch(
    `${baserowUrl}/api/database/rows/table/${requirementsTableId}/${requirementId}/?user_field_names=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Token ${baserowToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "QC Outcome": review.result === "passed" ? "Passed" : "Failed",
        "QC Notes": review.notes,
        "QC Reviewed By": profilesById.get(review.reviewed_by) ?? "Unknown reviewer",
        "QC Reviewed At": review.reviewed_at,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Unable to sync production requirement ${requirementId} (${response.status}): ${detail.slice(0, 300)}`);
  }
}

console.log(`Synced ${latestByRequirement.size} production requirement QC mirror(s) to Baserow.`);
