import { redirect } from "next/navigation";

import { ManufacturingDashboard } from "@/components/manufacturing-dashboard";
import { getAppUser, isAuthRequired } from "@/lib/auth";

export default async function Home() {
  if (isAuthRequired()) {
    const user = await getAppUser();
    if (!user) redirect("/login");
    if (!user.approved) redirect("/pending");
  }
  return <ManufacturingDashboard />;
}
