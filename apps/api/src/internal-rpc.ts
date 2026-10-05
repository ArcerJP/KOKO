import { object, readApiSettings, type AccountEnv } from "./api-context";

export type InternalRpcName =
  | "manage_stream_processing"
  | "media_processing_status"
  | "stage_three_outbox"
  | "resolve_stream_webhook"
  | "manage_capacity_monitor";
export type InternalRpc = (
  name: InternalRpcName,
  input: object,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
/** Service-only fixed RPC transport; no caller URL, redirect, raw body or error logging. */
export function createInternalRpc(
  env: AccountEnv,
  fetcher: typeof fetch = fetch,
): InternalRpc {
  const settings = readApiSettings(env);
  if (!settings) throw new Error("INTERNAL_RPC_NOT_CONFIGURED");
  return async (name, input, outer) => {
    if (
      ![
        "manage_stream_processing",
        "media_processing_status",
        "stage_three_outbox",
        "resolve_stream_webhook",
        "manage_capacity_monitor",
      ].includes(name)
    )
      throw new Error("INTERNAL_RPC_INVALID");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancel = () => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      rejectAbort?.();
    };
    outer?.addEventListener("abort", cancel, { once: true });
    if (outer?.aborted) cancel();
    try {
      return await Promise.race([
        (async () => {
          controller.signal.throwIfAborted();
          const response = await fetcher(
            new URL(`/rest/v1/rpc/${name}`, settings.url),
            {
              method: "POST",
              redirect: "manual",
              cache: "no-store",
              signal: controller.signal,
              headers: {
                apikey: settings.secretKey,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify(input),
            },
          );
          reader = response.body?.getReader();
          try {
            if (
              controller.signal.aborted ||
              response.redirected ||
              response.status !== 200 ||
              !reader ||
              !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                response.headers.get("content-type") ?? "",
              )
            )
              throw new Error();
            let text = "",
              size = 0;
            const decoder = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: false,
            });
            for (;;) {
              const chunk = await reader.read();
              controller.signal.throwIfAborted();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 65536) throw new Error();
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
            const value: unknown = JSON.parse(text);
            if (!object(value) || typeof value.code !== "string")
              throw new Error();
            return value;
          } finally {
            // This also runs if a non-cooperative fetch resolves after the outer timeout.
            void reader?.cancel().catch(() => {});
            reader?.releaseLock();
          }
        })(),
        new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new Error());
          if (controller.signal.aborted) rejectAbort();
          timer = setTimeout(() => {
            cancel();
            reject(new Error());
          }, 5000);
        }),
      ]);
    } catch {
      throw new Error("INTERNAL_RPC_FAILED");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", cancel);
      cancel();
    }
  };
}
