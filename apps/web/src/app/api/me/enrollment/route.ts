import { handleEnrollmentProxy } from "../../../../api/enrollment-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function handle(request: Request) {
  return handleEnrollmentProxy(request);
}
export {
  handle as GET,
  handle as POST,
  handle as PATCH,
  handle as DELETE,
  handle as PUT,
  handle as HEAD,
  handle as OPTIONS,
};
