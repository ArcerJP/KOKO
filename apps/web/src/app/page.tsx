import { CaptureLab } from "../components/capture-lab";
import { redirect } from "next/navigation";
import { accountEventId } from "../api/account-config";

export const dynamic = "force-dynamic";

export default function Home() {
  if (
    process.env.KOKO_PUBLIC_FEED_ENABLED === "true" &&
    accountEventId(process.env)
  )
    redirect("/feed");
  return <CaptureLab />;
}
