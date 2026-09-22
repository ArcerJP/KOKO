# 合成メディアfixture

実在の人物・位置情報・アカウントを含まない、KOKOのテスト専用素材です。2026-09-22に`generate.mjs`で生成しました。canvasの色・文字と440 Hzの合成音を使用し、写真は同じcanvasのPNGです。外部の写真・動画は使用していません。

| ファイル        | bytes | SHA-256                                                          |
| --------------- | ----- | ---------------------------------------------------------------- |
| photo.png       | 2270  | 394e46719b14a53b96f9db8402755132fb73cdd85e65c89f53955b1dab6576a1 |
| motion-vp8.webm | 99415 | 1ffc630884f878d5ffe3020c17e7246fe47501cc17a5242f1833237fa70ba2e6 |
| motion-vp9.webm | 94546 | d0ab8a96872ac42beb12e3c8b5d12d3d20cf7dce3345fec3ca45f15d9e92ca96 |

生成環境：Playwright 1.63.0、Chromium 153.0.8010.12（build 1243）、Windows。映像160×120、10 fps、VP8／VP9、音声Opus、録画待機5.2秒。実測のcontainer durationは録画タイミングによって異なります。

再生成する場合だけ、リポジトリルートで実行します。

```powershell
npm.cmd exec --workspace @koko/web -- playwright install chromium
node apps/web/test/fixtures/generate.mjs
```

通常のtest／CIでは再生成せず、追跡済みの固定fixtureを使います。再生成はこれら3ファイルを上書きするため、変更目的を確認したうえで行い、ハッシュと試験結果を更新してください。リアルタイム録画なので、再生成時のバイト列が同じになることは保証しません。

HEIC、H.264、HEVC、実カメラのrotation metadata、可変フレームレート、色・HDR、可聴の音ずれ、実機メモリ限界の受入れは別試験です。実端末のメディアをこのディレクトリへ無断で追加しません。
