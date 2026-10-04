import { handleAccountProxy } from "../../../api/account-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handle(request: Request) {
  return handleAccountProxy(request, "me");
}

export {
  handle as GET,
  handle as PATCH,
  handle as POST,
  handle as DELETE,
  handle as PUT,
  handle as HEAD,
  handle as OPTIONS,
};
