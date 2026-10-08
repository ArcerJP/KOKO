import { createRoot } from "react-dom/client";
import { FeedPanel } from "../src/app/feed/feed-panel";
import { eventId, owner } from "../test/feed-fixture";
const theme = new URL(location.href).searchParams.get("theme_id") ?? undefined;
createRoot(document.getElementById("root")!).render(
  <main className="shell">
    <h1>みんなの投稿・合成検証</h1>
    <FeedPanel owner={owner} eventId={eventId} {...(theme ? { theme } : {})} />
  </main>,
);
