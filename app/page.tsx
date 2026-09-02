import { redirect } from "next/navigation";

import { ManufacturingDashboard } from "@/components/manufacturing-dashboard";
import { getAppUser, isAuthRequired, recordSiteVisit } from "@/lib/auth";

export default async function Home() {
  if (isAuthRequired()) {
    const user = await getAppUser();
    if (!user) redirect("/login");
    await recordSiteVisit(user.id);
    if (!user.approved) redirect("/pending");
  }
  return <ManufacturingDashboard />;
}
