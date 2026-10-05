import { handleOperationsProxy } from "../../../../api/operations-proxy";
import { handleFeedProxy } from "../../../../api/feed-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const DELETE = (request: Request) => handleOperationsProxy(request);
export const GET = (request: Request) => handleFeedProxy(request);
