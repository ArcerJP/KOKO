import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureMedia, trimVideo } from "../src/media/trim-video";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const fixture = async (name: string) =>
  new Blob(
    [
      new Uint8Array(
        await readFile(new URL(`./fixtures/${name}`, import.meta.url)),
      ),
    ],
    { type: "video/webm" },
  );

async function packets(blob: Blob) {
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    return await Promise.all(
      (await input.getTracks()).map(async (track) => {
        const hashes: string[] = [];
        for await (const packet of new EncodedPacketSink(track).packets())
          hashes.push(hash(packet.data));
        return hashes;
      }),
    );
  } finally {
    input.dispose();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("実メディアの無再エンコード処理", () => {
  for (const filename of ["motion-vp8.webm", "motion-vp9.webm"]) {
    it.each([3.8, 3.5, 3.0] as const)(
      `${filename}を%s秒へ縮め、音声・原本・圧縮済みデータを維持する`,
      async (target) => {
        const original = await fixture(filename);
        const before = hash(new Uint8Array(await original.arrayBuffer()));
        const originalPackets = await packets(original);
        const progress: number[] = [];
        const result = await trimVideo(original, target, (value) =>
          progress.push(value),
        );
        expect(result.status).toBe("ready");
        if (result.status !== "ready") throw new Error(result.reason);
        expect(result.input.duration).toBeGreaterThan(5);
        expect(result.output.duration).toBeGreaterThan(0);
        expect(result.output.duration).toBeLessThanOrEqual(4);
        expect(result.output.video).toHaveLength(1);
        expect(result.output.audio).toHaveLength(1);
        expect(result.blob.size).toBeLessThan(original.size);
        expect(hash(new Uint8Array(await original.arrayBuffer()))).toBe(before);
        const outputPackets = await packets(result.blob);
        expect(outputPackets).toHaveLength(originalPackets.length);
        outputPackets.forEach((track, index) => {
          expect(track.length).toBeGreaterThan(0);
          // タイムスタンプやcontainerは変わっても、圧縮済みpacketは原本の先頭部分と同一。
          expect(track).toEqual(originalPackets[index]!.slice(0, track.length));
        });
        expect(progress.every((value) => value >= 0 && value <= 1)).toBe(true);
      },
    );
  }
  it("短い原本を延長しない", async () => {
    const first = await trimVideo(await fixture("motion-vp8.webm"), 3);
    if (first.status !== "ready") throw new Error(first.reason);
    const second = await trimVideo(first.blob, 3.8);
    expect(second.status).toBe("ready");
    if (second.status === "ready")
      expect(second.output.duration).toBeLessThanOrEqual(first.output.duration);
  });
  it("空・破損ファイルと外部URLのplaylistを送信せずfallbackにする", async () => {
    const network = vi.fn(() => {
      throw new Error("外部接続は禁止");
    });
    vi.stubGlobal("fetch", network);
    for (const content of [
      "",
      "not a video",
      "#EXTM3U\n#EXTINF:5,\nhttps://example.invalid/private.ts",
    ]) {
      expect(await trimVideo(new Blob([content]), 3.8)).toMatchObject({
        status: "fallback",
        reason: "unreadable",
      });
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("取消し済みsignalでは処理を開始しない", async () => {
    const signal = AbortSignal.abort(new DOMException("中止", "AbortError"));
    await expect(
      trimVideo(new Blob(["x"]), 3.8, undefined, signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("写真を動画として採用しない", async () => {
    expect(await trimVideo(await fixture("photo.png"), 3.8)).toMatchObject({
      status: "fallback",
    });
    await expect(measureMedia(new Blob(["broken"]))).rejects.toThrow();
  });
});
