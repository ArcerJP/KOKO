import type { PublicPost } from "../src/api/feed-contract";
import type { Me } from "../src/api/client";
import { mockEventId, mockMe } from "../src/mocks/handlers";
export const eventId = mockEventId;
export const owner = mockMe.user_id;
export const theme = "00000000-0000-4000-8000-000000000011";
export const cursor = `synthetic.${"a".repeat(43)}`;
export const me: Me = { ...mockMe, consent_required: false };
export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function publicPost(n = 100, video = false): PublicPost {
  const postId = id(n),
    base = `/media/${eventId}/${postId}/`;
  return {
    id: postId,
    event_id: eventId,
    display_name: `投稿者${n}`,
    crown: "none",
    like_count: 0,
    theme_id: null,
    theme_name: null,
    created_at: new Date(Date.UTC(2026, 9, 10, 0, 0, n)).toISOString(),
    ...(video
      ? {
          kind: "video",
          media: {
            kind: "video",
            hls_url: `${base}hls`,
            thumbnail_url: `${base}thumbnail`,
            duration_seconds: 3.8,
          },
        }
      : {
          kind: "photo",
          media: {
            kind: "photo",
            webp_600: `${base}webp-600`,
            jpg_600: `${base}jpg-600`,
            webp_1600: `${base}webp-1600`,
            jpg_1600: `${base}jpg-1600`,
          },
        }),
  };
}
export const feedPage = (
  start = 100,
  count = 3,
  next: string | null = null,
) => ({
  items: Array.from({ length: count }, (_, n) => publicPost(start - n)),
  next_cursor: next,
});
