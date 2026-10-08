import { handleFeedProxy } from "../../../api/feed-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleFeedProxy(request);
