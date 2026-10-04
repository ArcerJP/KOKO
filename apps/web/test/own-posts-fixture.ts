import type { OwnPost, OwnPostsPage } from "../src/api/own-posts-contract";
import { mockEventId, mockMe } from "../src/mocks/handlers";

// Synthetic only: never a real account, post or signed cursor.
export { mockEventId as eventId, mockMe as me };
export const origin = "https://web.example.test";
export const cursor = `synthetic.${"a".repeat(43)}`;
export function post(index = 1, changes: Partial<OwnPost> = {}): OwnPost {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    event_id: mockEventId,
    created_at: new Date(Date.UTC(2026, 9, 5) - index * 1000).toISOString(),
    version: 1,
    status: "uploaded",
    ...changes,
  };
}
export function page(
  start = 1,
  count = 30,
  next: string | null = cursor,
): OwnPostsPage {
  return {
    items: Array.from({ length: count }, (_, n) => post(start + n)),
    next_cursor: next,
  };
}
