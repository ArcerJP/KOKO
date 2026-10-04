import "server-only";
import {
  ApiFailure,
  createApiClient,
  type AcceptTerms,
  type UpdateMe,
} from "./client";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";

export async function handleAccountProxy(
  request: Request,
  resource: "me" | "consents",
  config: ProxyConfiguration = proxyConfiguration(),
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return handleJsonProxy(
    request,
    {
      path: resource,
      methods: resource === "me" ? ["GET", "PATCH"] : ["POST"],
      inputLimit: 1024,
      responseLimit: 16 * 1024,
      status: 200,
      async run({ base, eventId, input, csrf, signal, fetcher: forward }) {
        const client = createApiClient(base, eventId, forward);
        if (request.method === "GET") {
          const me = await client.getMe(signal);
          if (!me.csrf_token) throw new ApiFailure("INTERNAL_ERROR");
          return me;
        }
        return resource === "me"
          ? client.updateMe(input as UpdateMe, csrf, signal)
          : client.acceptTerms(input as AcceptTerms, csrf, signal);
      },
    },
    config,
    fetcher,
  );
}
