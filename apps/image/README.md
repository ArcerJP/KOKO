# 画像変換コア（B1-7／B2-1の一部）

Node.js 24で、入力bufferからAI用JPEGと閲覧用WebP/JPEGを生成します。`src/index.ts`が呼出し境界、`convert.ts`が変換、`worker.ts`が同期decoderの隔離、`cli.ts`がローカル受入用です。API/Webへはまだ接続しません。

## 実装と未実装

- HEIC：`heic-decode`のlibheif WASMで単一画像をRGBAへdecodeし、sharpへ渡す。その他はsharpのdecoderを利用。
- 長辺1024 JPEG、600/1600 WebP・JPEGの計5種類。縦横比維持、拡大なし、向き補正、sRGB、透明部は白へ合成。JPEG quality 85、WebP quality 82。画質の実機受入は未完了。
- EXIF/ICC/XMP/IPTCを派生物へ保持しない。原本bufferを変更せず、原本の保存/削除や公開状態は操作しない。
- 戻り値は固定名・形式・寸法・SHA-256・bytes。固定名はローカルの用途名でありR2キーではない。後続の保存adapterが契約のキーへ対応付ける。
- 同一process内は1変換だけ。実行中は`BUSY`。1回ごとにWorkerを作成し、既定15秒で停止してから次の処理を許可。自動retryなし。
- 空入力/不正な期限は`INVALID_INPUT`、decode不可能・複数画像は`DECODE_FAILED`、期限は`TIMEOUT`、Worker起動/異常終了は`WORKER_FAILED`。失敗時に部分的な派生物を返さない。raw例外/metadata/依存ログは外へ出さない。

HEICの多画像やアニメーションを先頭だけに切り捨てず失敗させます。これは公開許可や業務上の投稿拒否ではありません。後続consumerは原本保持・非公開保留・通知/再実行へ接続する必要があります。現在はそのDB処理を行っていません。

sharp既定相当の268,402,689画素制限とdecoder/メモリ/期限の実行限界があります。投稿APIのサイズ・形式制限ではなく、全画像の変換成功を保証しません。Workerの256MiB V8 heap制限はnative/WASM領域を含む完全なメモリsandboxではありません。本番ではプロセス/コンテナーの制限とバックプレッシャが別途必要です。

15秒は停止要求を出す期限です。native処理の終了待ちを含む厳密な応答時間の上限ではなく、停止完了までは次の変換枠を開放しません。

**これはCloud Run向けの変換コアとローカルCLIの段階です。** HTTP待受/サービス間認証、固定R2キーの取得/保存、Queue consumer、判定・公開は未実装。CLIコンテナーをそのままCloud Run serviceへ配備できるとは扱いません。実機HEIC、HDR/広色域/特殊な向き、巨大/破損画像の網羅、30投稿/分・公開中央値60秒も未受入です。特にWASMのRGBA出力に原本ICCを移さないため、実機の色再現を確認するまで本番有効化しません。

## ローカル検証

KOKOルートで実行します。依存はroot lockfileに固定し、既存Webのsharp版は変更しません。

```powershell
npm.cmd ci --include=dev --strict-peer-deps
npm.cmd run typecheck:image
npm.cmd run test:image
npm.cmd run build:image
npm.cmd run test:image:docker
```

最後のcommandはDockerのLinux engineが必要です。`runtime`をbuildし、その同じruntime成果物/本番依存に試験だけを追加した`verification`を実行します。非root、通信なし、read-only rootfs、64MiB tmpfs、1GiBメモリ、2 CPU、128 PID、capabilityなし。fixture-generatorは通常検査に使わずruntimeにも含めません。コンテナーは終了後`--rm`で除去し、local image/cacheは再利用のため残します。registryへのpush・クラウド配備・ログインはありません。

ベースNodeイメージはtagとdigestを固定し、Dockerfile専用ignoreのallowlistでソース/合成試験とpackage/lockだけをbuild contextへ送ります。npm lifecycleを実行しないのはこの独立したcontainer内だけで、Huskyや他workspaceの配備前処理を混入させないためです。sharpのprebuilt optional依存で実変換試験を通すことを必須とし、ホストの通常`npm ci`は既存hookを維持します。

## 実機素材の受入

本人が提供範囲を確認した、人物・個人情報のない試験写真だけを使用します。位置情報を含む既存写真の無断利用、原本/生成物のGit追加・チャット添付はしません。非公開の動的work内へ置き、build後に次のCLIで検証できます。パスは実際の対象に置き換えます。

```powershell
node apps/image/dist/cli.js "入力ファイルの絶対パス" "まだ存在しない出力フォルダーの絶対パス"
```

親フォルダーは事前に存在する必要があります。入力は読取りのみ、出力は新規ディレクトリ限定で既存物を上書きしません。5ファイルの後にmanifestを作成し、成功時は`IMAGE_TRANSFORM_COMPLETE`だけを表示。書込失敗では部分ディレクトリが残り得るため、manifest不在を完成扱いにせず、内容確認なしに削除/上書きしません。原本SHA-256の前後一致、5派生物の画素/向き/色・metadata除去を確認してください。

## 依存と配布境界

sharp 0.35.5（Apache-2.0）、heic-decode 2.1.0（ISC）、lockfileで解決するlibheif-js 1.23.5（LGPL-3.0）を使用。upstreamコードは改変せず、npm package同梱のLICENSE/通知を削除しません。FE bundleへ入れず、ソースは[sharp](https://github.com/lovell/sharp)、[heic-decode](https://github.com/catdad-experiments/heic-decode)、[libheif-js](https://github.com/catdad-experiments/libheif-js)を参照。コンテナー/codec binaryを外部配布する前に、組込みcodecも含めた通知・対応ソースの提供条件を確認します。今回registryへの配布はありません。

native libvips/HEVC構成を自前buildする案より、Windows/Linuxの導入差とビルド保守を減らすためWASM decodeを採用しました。一方で同期処理/メモリ/色再現の制約があり、Worker隔離と実機ゲートを設けます。[sharp公式](https://sharp.pixelplumbing.com/install/)のprebuilt HEIF表示だけでは、HEVC版HEIC対応を保証できません。

2026-10-05のnpm監査は新規実行依存の指摘0、全体の開発依存High 7は既存braces経路のままです。既知の指摘0件を安全性の保証としません。既存課題は[CI規約](../../docs/ci.md#依存関係のセキュリティ更新)へ集約します。
