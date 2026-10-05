import { createRoot } from "react-dom/client";
import { ManagePanel } from "../src/app/manage/manage-panel";
import { AppealPanel } from "../src/app/appeal/appeal-panel";
import { ThemesPanel } from "../src/app/themes/themes-panel";
import { PostActions } from "../src/components/post-actions";
import { mockEventId } from "../src/mocks/handlers";
const view = new URL(location.href).searchParams.get("view");
createRoot(document.getElementById("root")!).render(
  <main className="shell">
    <h1>運営・利用者操作の合成検証</h1>
    {view === "appeal" ? (
      <AppealPanel eventId={mockEventId} />
    ) : view === "themes" ? (
      <ThemesPanel eventId={mockEventId} />
    ) : view === "report" || view === "delete-own" ? (
      <PostActions
        eventId={mockEventId}
        postId="00000000-0000-4000-8000-000000000010"
        mode={view}
      />
    ) : (
      <ManagePanel eventId={mockEventId} />
    )}
  </main>,
);
