// Portable implementation shared with the Vercel server-only relay.
export {
  createCloudRunClient,
  createWorkloadIdentityToken,
  type CloudRunClient,
  type ProcessingJob,
  type WorkloadIdentityConfig,
} from "@koko/processing/cloud-run-client";
