import { afterEach, expect, it, vi } from "vitest";
import { createUploadClient } from "../src/api/upload-client";
import { transferOriginal } from "../src/media/upload-transfer";
import {
  csrf,
  destination,
  input,
  multipart,
  origin,
  postId,
  receipt,
  signed,
  single,
  uploadId,
} from "./upload-fixture";

afterEach(() => vi.useRealTimers());
const blob = new Blob(["abc"], { type: "image/png" });
const large = new Blob([new Uint8Array(5 * 1024 ** 2), "xyz"]);
const largeInput = { ...input, file_size_bytes: large.size };
const signParts = vi.fn(async (numbers: number[]) => ({
  parts: numbers.map((part_number) => ({
    part_number,
    ...signed(part_number),
  })),
}));
it("performs admission → conditional R2 PUT → complete 202 without forwarding credentials to R2", async () => {
  const control = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(single()))
    .mockResolvedValueOnce(Response.json(receipt, { status: 202 }));
  const client = createUploadClient(
    new URL(`${origin}/api/`),
    destination,
    control,
  );
  const session = await client.open(input, csrf);
  const r2 = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 200 }),
  );
  const result = await transferOriginal(blob, input, session, destination, {
    fetcher: r2,
    signParts,
  });
  expect(await client.complete(postId, result, csrf)).toEqual(receipt);
  expect(result).toEqual({ upload_id: uploadId });
  expect(signParts).not.toHaveBeenCalled();
  expect(r2).toHaveBeenCalledTimes(1);
  const [, init] = r2.mock.calls[0]!;
  expect(init).toMatchObject({
    method: "PUT",
    body: blob,
    headers: { "content-type": "image/png", "if-none-match": "*" },
    credentials: "omit",
    mode: "cors",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
});
it("slices multipart sequentially, signs just in time and records normalized ETags", async () => {
  const events: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_, init) => {
    events.push(`put:${(init!.body as Blob).size}`);
    return new Response(null, { headers: { etag: `"${"d".repeat(32)}"` } });
  });
  const signedParts = vi.fn(async (numbers: number[]) => {
    events.push(`sign:${numbers[0]}`);
    return signParts(numbers);
  });
  const result = await transferOriginal(
    large,
    largeInput,
    multipart(),
    destination,
    {
      fetcher,
      signParts: signedParts,
      onPart: (part) => {
        events.push(`saved:${part.part_number}`);
        part.etag = "tampered";
      },
    },
  );
  expect(result).toEqual({
    upload_id: uploadId,
    parts: [
      { part_number: 1, etag: "d".repeat(32) },
      { part_number: 2, etag: "d".repeat(32) },
    ],
  });
  expect(events).toEqual([
    "sign:1",
    `put:${5 * 1024 ** 2}`,
    "saved:1",
    "sign:2",
    "put:3",
    "saved:2",
  ]);
  expect(await (fetcher.mock.calls[1]![1]!.body as Blob).text()).toBe("xyz");
  expect(fetcher.mock.calls[0]![1]!.headers).toEqual({});
});
it.each(["missing", "invalid", "quoted-invalid"])(
  "stops on %s ETag without sending next part",
  async (kind) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          headers: kind === "missing" ? {} : { etag: kind },
        }),
    );
    await expect(
      transferOriginal(large, largeInput, multipart(), destination, {
        fetcher,
        signParts,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each([302, 403, 412, 500, 204])(
  "does not retry R2 status %s",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status }),
    );
    await expect(
      transferOriginal(blob, input, single(), destination, {
        fetcher,
        signParts,
      }),
    ).rejects.toMatchObject({
      code: status === 412 ? "STATE_CONFLICT" : "UPLOAD_INCOMPLETE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("sanitizes ambiguous network loss and does not call complete", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error("signed-url-do-not-expose");
  });
  await expect(
    transferOriginal(blob, input, single(), destination, {
      fetcher,
      signParts,
    }),
  ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("requires matching Blob size and content declaration", async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const changed of [
    { ...input, file_size_bytes: 4 },
    { ...input, content_type: "image/jpeg" },
  ])
    await expect(
      transferOriginal(blob, changed, single(), destination, {
        fetcher,
        signParts,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("stops after cancellation without sending another part", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(null, { headers: { etag: "d".repeat(32) } }),
  );
  await expect(
    transferOriginal(large, largeInput, multipart(), destination, {
      fetcher,
      signParts,
      signal: controller.signal,
      onPart: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("aborts an in-flight PUT after 120 seconds", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(
    (_, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("private")),
        ),
      ),
  );
  const pending = expect(
    transferOriginal(blob, input, single(), destination, {
      fetcher,
      signParts,
    }),
  ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  await vi.advanceTimersByTimeAsync(120001);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects another post or changing provider upload between parts", async () => {
  for (const mode of ["post", "provider"]) {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { headers: { etag: "a".repeat(32) } }),
    );
    const wrong = async (numbers: number[]) => ({
      parts: numbers.map((n) => ({
        part_number: n,
        ...signed(n),
        put_url: signed(n).put_url.replace(
          mode === "post"
            ? postId
            : n === 2
              ? "synthetic-provider-id"
              : "not-present",
          "00000000-0000-4000-8000-000000000099",
        ),
      })),
    });
    await expect(
      transferOriginal(large, largeInput, multipart(), destination, {
        fetcher,
        signParts: wrong,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(mode === "post" ? 0 : 1);
  }
});
it("rejects expired part signatures before PUT", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const expired = async () => ({
    parts: [{ part_number: 1, ...signed(1, Date.now() - 601000) }],
  });
  await expect(
    transferOriginal(large, largeInput, multipart(), destination, {
      fetcher,
      signParts: expired,
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
  expect(fetcher).not.toHaveBeenCalled();
});
