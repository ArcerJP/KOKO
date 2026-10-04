import "server-only";
import { createApiClient } from "./client";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";
import {
  validCursor,
  ownPostsSearch,
  type OwnPostsQuery,
} from "./own-posts-contract";
import { validId } from "./upload-contract";

type Configuration = ProxyConfiguration & {
  KOKO_OWN_POSTS_PROXY_ENABLED?: string | undefined;
};
export async function handleOwnPostsProxy(
  request: Request,
  config: Configuration = {
    ...proxyConfiguration(),
    KOKO_OWN_POSTS_PROXY_ENABLED: process.env.KOKO_OWN_POSTS_PROXY_ENABLED,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const fail = (status: number, code: string) =>
    Response.json(
      { code, request_id: crypto.randomUUID() },
      {
        status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  if (config.KOKO_OWN_POSTS_PROXY_ENABLED !== "true")
    return fail(404, "NOT_FOUND");
  const url = new URL(request.url);
  const list = url.pathname === "/api/me/posts";
  const id = /^\/api\/posts\/([^/]+)\/status$/.exec(url.pathname)?.[1];
  if ((!list && !validId(id)) || (!list && url.search))
    return fail(400, "INVALID_INPUT");
  const query: OwnPostsQuery = {};
  for (const [name, value] of url.searchParams) {
    if (
      !list ||
      url.searchParams.getAll(name).length !== 1 ||
      !["limit", "cursor"].includes(name)
    )
      return fail(400, "INVALID_INPUT");
    if (name === "limit") {
      if (!/^(?:[1-9][0-9]?|100)$/.test(value))
        return fail(400, "INVALID_INPUT");
      query.limit = Number(value);
    } else {
      if (!validCursor(value)) return fail(400, "INVALID_CURSOR");
      query.cursor = value;
    }
  }
  const path = list ? "me/posts" : `posts/${id!.toLowerCase()}/status`;
  return handleJsonProxy(
    request,
    {
      path: url.pathname.slice(5),
      search: url.search,
      upstreamPath: path + (list ? ownPostsSearch(query)! : ""),
      methods: ["GET"],
      inputLimit: 0,
      responseLimit: 256 * 1024,
      status: 200,
      async run({ base, eventId, signal, fetcher: forward }) {
        const client = createApiClient(base, eventId, forward);
        return list
          ? client.listOwnPosts(query, signal)
          : client.getPostStatus(id!, signal);
      },
    },
    config,
    fetcher,
  );
}
