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

/** JWT/Cookie/CSRFを受け取らない、ブラウザlogoutの順序制御。 */
export async function completeSignOut(
  apiEnabled: boolean,
  signOut: () => Promise<{ error: unknown }>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let apiOk = !apiEnabled;
  if (apiEnabled) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = async () => {
        const response = await fetcher("/auth/api-sign-out", {
          method: "POST",
          headers: {
            "X-KOKO-Session-Request": "1",
            Accept: "application/json",
          },
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        return apiAcknowledgement(response, controller.signal);
      };
      apiOk = await Promise.race([
        operation(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, 10_000);
        }),
      ]);
    } catch {
      // 一部失敗でもAuth側の終了は試す。例外詳細はUIへ渡さない。
    } finally {
      clearTimeout(timer);
    }
  }
  let authOk = false;
  try {
    authOk = !(await signOut()).error;
  } catch {
    /* 固定エラーのみ */
  }
  if (!apiOk || !authOk) throw new Error("SIGN_OUT_INCOMPLETE");
}
