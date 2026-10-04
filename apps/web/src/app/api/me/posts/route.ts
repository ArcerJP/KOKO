import { handleOwnPostsProxy } from "../../../../api/own-posts-proxy";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleOwnPostsProxy(request);
export const POST = (request: Request) => handleOwnPostsProxy(request);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const HEAD = POST;
export const OPTIONS = POST;
