import { handleOperationsProxy } from "../../../../../api/operations-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleOperationsProxy(request);
