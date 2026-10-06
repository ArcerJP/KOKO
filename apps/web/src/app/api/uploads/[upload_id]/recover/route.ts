import { handleUploadProxy } from "../../../../../api/upload-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function handle(request: Request) {
  return handleUploadProxy(request);
}
export {
  handle as POST,
  handle as GET,
  handle as PATCH,
  handle as PUT,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
