import { operationsEntry, OperationsFrame } from "./_components/entry";
import { ManagePanel } from "./manage-panel";

export const dynamic = "force-dynamic";
export default async function ManagePage() {
  const entry = await operationsEntry();
  return (
    <OperationsFrame title="運営管理" enabled={entry !== null}>
      {entry ? (
        <ManagePanel
          key={`${entry.eventId}:${entry.owner}`}
          eventId={entry.eventId}
          realtimeEnabled={process.env.KOKO_ADMIN_REALTIME_ENABLED === "true"}
        />
      ) : null}
    </OperationsFrame>
  );
}
