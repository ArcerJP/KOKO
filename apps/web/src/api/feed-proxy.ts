import "server-only";
import { createFeedClient } from "./feed-client";
import { feedSearch, validFeedCursor, type FeedQuery } from "./feed-contract";
import { validId } from "./upload-contract";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";
type Config = ProxyConfiguration & {
  KOKO_PUBLIC_FEED_ENABLED?: string | undefined;
};
export function handleFeedProxy(
  request: Request,
  config: Config = {
    ...proxyConfiguration(),
    KOKO_PUBLIC_FEED_ENABLED: process.env.KOKO_PUBLIC_FEED_ENABLED,
  },
  fetcher: typeof fetch = fetch,
) {
  const fail = (code: string, status: number) =>
    Response.json(
      { code, request_id: crypto.randomUUID() },
      {
        status,
        headers: {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  if (config.KOKO_PUBLIC_FEED_ENABLED !== "true")
    return Promise.resolve(fail("NOT_FOUND", 404));
  const url = new URL(request.url),
    list = url.pathname === "/api/feed",
    id = /^\/api\/posts\/([^/]+)$/.exec(url.pathname)?.[1];
  if ((!list && !validId(id)) || (!list && url.search))
    return Promise.resolve(fail("INVALID_INPUT", 400));
  const query: FeedQuery = {};
  for (const [key, value] of url.searchParams) {
    if (
      !list ||
      !["theme", "limit", "cursor"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      return Promise.resolve(fail("INVALID_INPUT", 400));
    if (key === "limit") {
      if (!/^(?:[1-9][0-9]?|100)$/.test(value))
        return Promise.resolve(fail("INVALID_INPUT", 400));
      query.limit = Number(value);
    } else if (key === "theme") {
      if (!validId(value)) return Promise.resolve(fail("INVALID_INPUT", 400));
      query.theme = value.toLowerCase();
    } else {
      if (!validFeedCursor(value))
        return Promise.resolve(fail("INVALID_CURSOR", 400));
      query.cursor = value;
    }
  }
  return handleJsonProxy(
    request,
    {
      path: url.pathname.slice(5),
      search: url.search,
      upstreamPath: list
        ? `feed${feedSearch(query)}`
        : `posts/${id!.toLowerCase()}`,
      methods: ["GET"],
      inputLimit: 0,
      responseLimit: 262144,
      status: 200,
      run: ({ base, eventId, signal, fetcher: forward }) => {
        const client = createFeedClient(base, eventId, forward);
        return list ? client.list(query, signal) : client.post(id!, signal);
      },
    },
    config,
    fetcher,
  );
}
