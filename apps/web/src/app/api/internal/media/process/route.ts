import { handleProcessingRelay } from "../../../../../api/processing-relay";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleProcessingRelay(request);
