export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export {
  handleApiSignOut as POST,
  handleApiSignOut as GET,
  handleApiSignOut as DELETE,
  handleApiSignOut as PATCH,
  handleApiSignOut as PUT,
  handleApiSignOut as HEAD,
  handleApiSignOut as OPTIONS,
} from "../../../auth/api-sign-out";
