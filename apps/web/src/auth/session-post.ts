async function apiAcknowledgement(response: Response, signal: AbortSignal) {
  if (
    signal.aborted ||
    response.status !== 200 ||
    response.redirected ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  let length = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > 128) throw new Error("Invalid acknowledgement");
      text += decoder.decode(value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      "ok" in body &&
      body.ok === true
    );
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** 固定Web経路だけ。10秒/128byte、親取消しも伝播。Cookie/JWTは引数にしない。 */
export async function postApiSession(
  path: "/auth/api-session" | "/auth/api-sign-out",
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    const stopped = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
      combined.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => controller.abort(), 10_000);
    });
    return await Promise.race([
      stopped,
      (async () => {
        const response = await fetcher(path, {
          method: "POST",
          headers: {
            "X-KOKO-Session-Request": "1",
            Accept: "application/json",
          },
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: combined,
        });
        return apiAcknowledgement(response, combined);
      })(),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", cancel);
    controller.abort();
  }
}
