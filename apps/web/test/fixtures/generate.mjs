import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

// 人物・位置情報・外部サイトを使用しない、自作の色面・文字・合成音だけ。
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const fixtures = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    const sound = new AudioContext();
    const tone = sound.createOscillator();
    const gain = sound.createGain();
    const destination = sound.createMediaStreamDestination();
    gain.gain.value = 0.05;
    tone.frequency.value = 440;
    tone.connect(gain).connect(destination);
    await sound.resume();
    tone.start();
    const stream = canvas.captureStream(10);
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    const recorders = ["vp8", "vp9"].map((codec) => {
      const recorder = new MediaRecorder(stream, {
        mimeType: `video/webm;codecs=${codec},opus`,
        videoBitsPerSecond: 60000,
      });
      const chunks = [];
      const complete = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => chunks.push(event.data);
        recorder.onerror = reject;
        recorder.onstop = async () =>
          resolve(
            Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())),
          );
      });
      recorder.start();
      return { recorder, complete };
    });
    let frame = 0;
    const draw = () => {
      context.fillStyle = ["#4338ca", "#166534", "#92400e"][
        Math.floor(frame / 10) % 3
      ];
      context.fillRect(0, 0, 160, 120);
      context.fillStyle = "white";
      context.font = "16px sans-serif";
      context.fillText(`KOKO TEST ${frame++}`, 8, 60);
    };
    draw();
    const photo = canvas.toDataURL("image/png").split(",")[1];
    const timer = setInterval(draw, 100);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    for (const { recorder } of recorders) recorder.stop();
    const videos = await Promise.all(recorders.map(({ complete }) => complete));
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    tone.stop();
    await sound.close();
    return { photo, videos };
  });
  await writeFile(
    new URL("photo.png", import.meta.url),
    Buffer.from(fixtures.photo, "base64"),
  );
  await writeFile(
    new URL("motion-vp8.webm", import.meta.url),
    Buffer.from(fixtures.videos[0]),
  );
  await writeFile(
    new URL("motion-vp9.webm", import.meta.url),
    Buffer.from(fixtures.videos[1]),
  );
  process.stdout.write("合成写真・VP8/VP9＋音声fixtureを生成しました。\n");
} finally {
  await browser.close();
}
