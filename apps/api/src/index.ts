const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function json(body: object, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export default {
  async fetch(request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      if (request.method !== "GET") {
        return json(
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }

      return json({ service: "koko-api", status: "ok" }, 200);
    }

    return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  },
} satisfies ExportedHandler<Env>;
