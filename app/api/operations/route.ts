import { NextResponse } from "next/server";

import { getOperations } from "@/lib/baserow";
import { getCurrentUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (process.env.REQUIRE_AUTH === "true" && !user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const data = await getOperations();
    return NextResponse.json({
      ...data,
      syncedAt: new Date().toISOString(),
      user: user
        ? { name: user.user_metadata.full_name ?? user.user_metadata.name ?? user.email ?? "Machinist", email: user.email ?? null }
        : { name: "Corey Lu", email: null },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load operations" },
      { status: 502 },
    );
  }
}
