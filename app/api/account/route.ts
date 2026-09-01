import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";

export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return NextResponse.json({ user });
}
