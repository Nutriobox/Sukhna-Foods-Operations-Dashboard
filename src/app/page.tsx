import Dashboard from "@/components/Dashboard";
import { seedBills } from "@/lib/data";

// Render immediately with the seed bills. If Supabase is configured, the
// client component swaps in live data on mount.
export default function Page() {
  return <Dashboard initialBills={seedBills} />;
}
