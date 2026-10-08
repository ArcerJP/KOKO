import { operationsEntry, OperationsFrame } from "../manage/_components/entry";
import { ThemesPanel } from "./themes-panel";
export const dynamic = "force-dynamic";
export default async function ThemesPage() {
  const entry = await operationsEntry();
  return (
    <OperationsFrame title="お題" enabled={entry !== null}>
      {entry ? (
        <ThemesPanel
          key={`${entry.eventId}:${entry.owner}`}
          eventId={entry.eventId}
        />
      ) : null}
    </OperationsFrame>
  );
}
