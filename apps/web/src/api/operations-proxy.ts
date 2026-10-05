import "server-only";
import { createOperationsClient, operationPayload } from "./operations-client";
import {
  operationRoute,
  type Operation,
  type OperationName,
} from "./operations-contract";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";

type Configuration = ProxyConfiguration & {
  KOKO_STAGE_THREE_ENABLED?: string | undefined;
};
/** Allowlisted same-origin JSON routes only; never a general URL/method proxy. */
export async function handleOperationsProxy(
  request: Request,
  config: Configuration = {
    ...proxyConfiguration(),
    KOKO_STAGE_THREE_ENABLED: process.env.KOKO_STAGE_THREE_ENABLED,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const fail = (status: number, code: string) =>
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
  if (config.KOKO_STAGE_THREE_ENABLED !== "true") return fail(404, "NOT_FOUND");
  const url = new URL(request.url);
  const routeNames: OperationName[] = [
    "themes",
    "adminThemes",
    "adminFeed",
    "appeals",
    "settings",
    "report",
    "appeal",
    "deleteOwn",
    "hide",
    "restore",
    "deletePost",
    "retry",
    "reassignTheme",
    "ban",
    "unban",
    "createTheme",
    "updateTheme",
    "deleteTheme",
    "resolveAppeal",
    "updateSettings",
  ];
  const pieces = url.pathname.split("/");
  let found: Operation | undefined;
  for (const name of routeNames) {
    const candidates: Operation[] = [
      { name },
      ...pieces.map((id) => ({ name, id })),
    ];
    for (const candidate of candidates) {
      try {
        const route = operationRoute(candidate);
        if (
          url.pathname === `/api/${route.path}` &&
          request.method === route.method
        ) {
          found = candidate;
          break;
        }
      } catch {
        /* Not this allowlisted route. */
      }
    }
    if (found) break;
  }
  if (!found) return fail(404, "NOT_FOUND");
  try {
    if (found.name === "adminFeed" || found.name === "appeals") {
      if (
        [...url.searchParams].some(
          ([key]) =>
            !["limit", "cursor"].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        ) ||
        url.searchParams.get("limit") !== "30"
      )
        return fail(400, "INVALID_INPUT");
      if (url.searchParams.has("cursor"))
        found.cursor = url.searchParams.get("cursor")!;
    } else if (url.search) return fail(400, "INVALID_INPUT");
    const op = found,
      route = operationRoute(op);
    // Canonical search makes duplicate/reordered/unrecognised query forms fail closed.
    if (route.search !== url.search) return fail(400, "INVALID_INPUT");
    return handleJsonProxy(
      request,
      {
        path: route.path,
        search: route.search,
        upstreamPath: route.path + route.search,
        methods: [route.method],
        inputLimit: route.mutation ? 32768 : 0,
        responseLimit: 262144,
        status: 200,
        async run({ base, eventId, input, csrf, signal, fetcher: forward }) {
          return operationPayload(
            await createOperationsClient(base, eventId, forward).execute(
              op,
              input,
              csrf,
              signal,
            ),
          );
        },
      },
      config,
      fetcher,
    );
  } catch {
    return fail(400, "INVALID_INPUT");
  }
}
