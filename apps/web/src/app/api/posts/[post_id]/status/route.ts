import { handleOwnPostsProxy } from "../../../../../api/own-posts-proxy";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleOwnPostsProxy(request);
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
