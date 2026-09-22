import { describe, expect, it } from "vitest";
import {
  checkTrimOutput,
  isSafeDuration,
  isTrimTarget,
  type MediaMeasurement,
} from "../src/media/trim-policy";

const media = (): MediaMeasurement => ({
  start: 0,
  duration: 3.8,
  video: [
    {
      codec: "avc",
      start: 0,
      end: 3.8,
      width: 1080,
      height: 1920,
      rotation: 90,
      flipped: false,
    },
  ],
  audio: [{ codec: "aac", start: 0, end: 3.79 }],
});

describe("公開契約を使う端末内の採用判定", () => {
  it.each([3.8, 3.5, 3.0])("承認済み目標 %s 秒だけを受理する", (target) =>
    expect(isTrimTarget(target)).toBe(true),
  );
  it.each([4, 2, NaN, Infinity])("未承認目標 %s を拒否する", (target) =>
    expect(isTrimTarget(target)).toBe(false),
  );
  it.each([0, -1, 4.00001, NaN, Infinity])(
    "危険な実測時間 %s を拒否する",
    (duration) => expect(isSafeDuration(duration)).toBe(false),
  );
  it("短い原本を延長せず、4秒ちょうどまでは許容する", () => {
    expect(isSafeDuration(0.1)).toBe(true);
    expect(isSafeDuration(4)).toBe(true);
    expect(checkTrimOutput(media(), media())).toBeNull();
  });
  it("映像の向き・サイズ・codec・音声の欠落を拒否する", () => {
    for (const change of [
      { rotation: 0 },
      { width: 720 },
      { codec: "vp9" },
      { flipped: true },
    ]) {
      const output = media();
      Object.assign(output.video[0]!, change);
      expect(checkTrimOutput(media(), output)).toBe("tracks");
    }
    const silent = media();
    silent.audio = [];
    expect(checkTrimOutput(media(), silent)).toBe("tracks");
    const empty = media();
    empty.video = [];
    expect(checkTrimOutput(media(), empty)).toBe("tracks");
  });
  it("全体だけでなく音声トラックの4秒超えも拒否する", () => {
    const output = media();
    output.audio[0]!.end = 4.01;
    expect(checkTrimOutput(media(), output)).toBe("duration");
  });
});
