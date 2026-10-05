import { handleMediaProxy } from "../../../../../../api/media-proxy";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleMediaProxy(request);
