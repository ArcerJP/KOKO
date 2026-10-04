import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PostsPanel } from "../src/app/account/posts/posts-panel";
import { eventId, me } from "../test/own-posts-fixture";

// Only bundled in the local Playwright harness, never a production route.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="shell">
      <h1>自分の投稿状況（合成試験）</h1>
      <PostsPanel owner={me.user_id} eventId={eventId} />
    </main>
  </StrictMode>,
);
