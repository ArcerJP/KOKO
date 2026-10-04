import { setApiGeneration } from "./api-session-cookies";
import { sessionReply, validateSessionRequest } from "./api-session-request";

/** API経路だけを終了。SupabaseのsignOutはbrowser側が別途行う。 */
export async function handleApiSignOut(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    const response = sessionReply(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", "POST");
    return response;
  }
  const rejected = await validateSessionRequest(request, "/auth/api-sign-out");
  if (rejected) return rejected;
  return setApiGeneration(sessionReply(200), "ended");
}
