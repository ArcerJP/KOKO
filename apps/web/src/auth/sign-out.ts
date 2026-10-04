import { postApiSession } from "./session-post";

/** JWT/Cookie/CSRFを受け取らない、ブラウザlogoutの順序制御。 */
export async function completeSignOut(
  apiEnabled: boolean,
  signOut: () => Promise<{ error: unknown }>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const apiOk =
    !apiEnabled ||
    (await postApiSession("/auth/api-sign-out", undefined, fetcher));
  let authOk = false;
  try {
    authOk = !(await signOut()).error;
  } catch {
    /* 固定エラーのみ */
  }
  if (!apiOk || !authOk) throw new Error("SIGN_OUT_INCOMPLETE");
}
