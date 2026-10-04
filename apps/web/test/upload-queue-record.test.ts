import { expect, it } from "vitest";
import {
  queueRecord,
  type QueueRecord,
} from "../src/media/upload-queue-record";
import { eventId, input, postId, uploadId } from "./upload-fixture";
const owner = "00000000-0000-4000-8000-000000000009";
const item: QueueRecord = {
  version: 1,
  id: input.client_request_id,
  owner,
  eventId,
  request: input,
  createdAt: 1,
  phase: "queued",
  session: null,
  checkpoint: null,
  manifest: null,
  failures: 0,
  nextAttemptAt: 0,
  paused: false,
  error: null,
};
it("projects a durable record without retaining mutable caller objects", () => {
  const result = queueRecord(item, owner, eventId);
  result.request.content_type = "changed";
  expect(item.request.content_type).toBe("image/png");
});
it.each([
  { version: 2 },
  { id: eventId },
  { owner: eventId },
  { eventId: owner },
  { phase: "other" },
  { failures: 5 },
  { failures: -1 },
  { nextAttemptAt: NaN },
  { paused: "false" },
  { error: "arbitrary secret" },
  { put_url: "https://example.test/signed" },
  { csrf: "synthetic value" },
  { phase: "transferring" },
  { checkpoint: { parts: [], identity: "a".repeat(64) } },
  { manifest: { upload_id: uploadId } },
  { session: { postId, uploadId, mode: "single", partSize: null } },
])("rejects corrupt or unexpected durable state %j", (change) => {
  expect(() => queueRecord({ ...item, ...change }, owner, eventId)).toThrow(
    "保存できません",
  );
});
it("rejects cross-owner/event reads, including terminal receipts", () => {
  expect(() => queueRecord(item, eventId, eventId)).toThrow();
  expect(() => queueRecord(item, owner, owner)).toThrow();
});
it("requires complete multipart manifest, ordered parts and fixed session", () => {
  const record = {
    ...item,
    phase: "completing",
    session: { postId, uploadId, mode: "multipart", partSize: 5 * 1024 ** 2 },
    manifest: {
      upload_id: uploadId,
      parts: [{ part_number: 1, etag: "d".repeat(32) }],
    },
  };
  expect(queueRecord(record, owner, eventId).phase).toBe("completing");
  expect(() =>
    queueRecord(
      {
        ...record,
        manifest: { upload_id: eventId, parts: record.manifest.parts },
      },
      owner,
      eventId,
    ),
  ).toThrow();
  expect(() =>
    queueRecord(
      { ...record, manifest: { upload_id: uploadId, parts: [] } },
      owner,
      eventId,
    ),
  ).toThrow();
});
