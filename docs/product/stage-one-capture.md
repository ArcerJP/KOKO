# 第1要件：撮影・トリム検証

更新日：2026-09-22。F1-2の端末調査用画面とF1-3のWeb基盤です。全体の受入状態は[開発計画](development-plan.md)を正本とします。

## できること・まだできないこと

- 写真／動画のOSカメラ・ファイル選択、受け取った原本のBlobプレビュー。
- Mediabunnyのコピー必須モードによる先頭からのトリム。標準3.8秒、比較時に3.5／3.0秒。別Workerで処理し、中止時は終了。
- 出力時間、映像・音声のトラック数、codec・サイズ・向きの維持を検査。条件を満たせなければ原本を保持してfallback表示。
- 実測時間・容量・処理時間と、人間の再生確認結果をJSONとして端末へ保存。
- 生成API型を使うGET境界と、MSWによるHTTP境界の自動試験。MSWはNodeテスト専用で、本番画面に偽ログインを提供しない。

Googleログイン、規約同意、R2アップロード、Stream clip、Cloud Run、AI判定、IndexedDB送信キューは未接続です。この画面ではメディアを外部送信せず、再読み込みで結果が失われます。出力は「トリム候補」であり、公開許可や投稿完了ではありません。

写真の原本は`File`を変更しません。プレビューできないHEIC等を勝手に圧縮しません。動画も再エンコード・リサイズを行わず、トラック欠落や4秒超の結果は採用しません。失敗時の全長原本→R2→Stream clipは後続実装です。入力形式はローカルのMP4／QuickTime／WebM／Matroskaに限定し、外部URLを参照するHLSプレイリストは読みません。これは後続の原本アップロードの業務上の形式制限を追加するものではありません。

## PCで起動する

リポジトリルートで、Node.js 24系・npmを使います。クラウドの鍵や`.env`は不要です。

```powershell
npm.cmd ci
npm.cmd run dev
```

表示された`http://127.0.0.1:3000`を開きます。終了はターミナルの`Ctrl+C`です。開発サーバーは既定でこのPCだけに公開します。

本番ビルドを確認する場合：

```powershell
npm.cmd run build:web
npm.cmd run start --workspace @koko/web
```

クラウドへの実配備手順は[準備ガイド](cloud-setup.md)へ分離しています。Next.jsの初回起動で生成される`next-env.d.ts`と`.next/`は追跡しません。

## iPhone・Androidでの確認

両方の実機を保有していることはiijimaさんから確認済みですが、機種・OSと実測結果は未確認です。スマートフォンの`localhost`はスマートフォン自身を指すため、PCのURLをそのまま開いても接続できません。

1. 機種、OS、ブラウザとバージョンを控えます。iPhoneはSafari、AndroidはChromeをまず使います。
2. 接続方法を選びます。推奨は承認後のHTTPS検証URLです。独自ドメインは必須ではありません。手元の信頼できるWi-Fi内だけで行う場合は、以下のLAN用起動も可能です。会社・大学・公衆Wi-Fiの規則を確認し、ルーターのポート開放や公開トンネルは行わないでください。

   ```powershell
   npm.cmd run build:web
   npm.cmd run start --workspace @koko/web -- --hostname 0.0.0.0 --port 3000
   ```

   PCのLAN内IPv4アドレスを確認し、スマートフォンで`http://<PCのLAN内IPv4>:3000`を開きます。Windowsの許可が必要ならPrivateネットワークだけを対象にしてください。HTTP/LANの試験はHTTPS・OAuth・ホーム画面起動の試験を代替しません。終了時は`Ctrl+C`で止め、一時的に追加した許可も元に戻します。Codexは今回ファイアウォールを変更していません。

3. 人物や個人情報を含まない物・風景で、写真を撮影→確認→クリア→撮り直します。写真ライブラリ選択も試し、非対応形式の表示と原本保持を確認します。
4. まず約30秒の動画を、音声付き・縦向きで撮影します。「3つの長さを比較する」を押し、各候補を最後まで再生します。映像の欠け・停止、音ずれ、向き、実測4秒以下を確認します。
5. 横向き、3秒未満、音声なし、前面カメラ、iPhoneの高効率／互換性優先など端末が選べる条件でも繰り返します。処理中の中止、別ファイルの選択、連続試行、バックグラウンド復帰も確認します。高解像度・長時間入力はメモリ不足の可能性があるため、元データを消さず段階的に試します。
6. 実際に確認できた項目だけチェックして「測定結果だけを保存（JSON）」を押します。機種／OS、撮影条件、失敗状況を添えて結果を知らせてください。映像そのものは不要です。JSONにはブラウザ情報が含まれるため、共有前に内容を確認し、Gitには追加しないでください。

端末のOSにより`capture`の扱いは異なります。ファイル選択が出ることや、設定どおりのカメラが開かないことも記録対象です。現在は開始位置を選ぶ編集UIや自動での最適秒数選択はありません。

## 自動検証と限界

| 層                  | 検証内容                                                                                                      | 証明しないこと                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Vitest              | 時間・トラック境界、原本保持、合成VP8／VP9＋音声の無再エンコード、packet一致、Worker中止、MSWの正常／異常応答 | 実端末カメラ、HEVC／H.264の全組合せ、実OAuth  |
| Playwright Chromium | production server、写真表示、Workerの実行、3候補の実再生、JSON、異常入力、PC／モバイル幅、外部送信なし        | iPhone実機、可聴音質・実写の画質、Android実機 |
| 実機（未実施）      | OSカメラ、向き・音ずれ、端末別duration、メモリ・中断・復帰                                                    | BE側の公開判定やクラウド保存                  |

合成fixtureの出自は[fixture説明](../../apps/web/test/fixtures/README.md)、コマンドと必須checkは[CI規約](../ci.md)を参照してください。全トラックの圧縮済みpacketのハッシュ一致を試験しますが、すべてのcodecでの成功率を測定したものではありません。

Mediabunnyは実測値が目標値どおりになると保証しません。キーフレームや音声パケット境界によって短くなる場合があります。ブラウザ側の時間表示も確認し、4秒超や読取不可を成功として報告しないでください。処理不能の場合は、本番公開時にBEが再計測・clip・必須AIを実施する設計を維持します。

## 実装の入口

- UI：`apps/web/src/app`と`src/components`。初期トークンを使用し、動的メディア処理は必要時に読み込む。
- 端末依存境界：`src/media/worker-client.ts`。ライブラリ処理と純粋な採用判定を別moduleへ分離。
- HTTP境界：`src/api/client.ts`。同一origin Cookie経由を前提とするGET基盤。認証やCSRF更新APIの完成ではない。
- 共通の型・業務契約：`packages/contract`。DOM、Next.js、Mediabunnyを共有契約へ持ち込まない。

新しい手順Skillは追加していません。今回の検証は既存の調査実装・Git・費用比較の手順で扱い、製品固有の実機受入方法はこの文書へ集約します。

## 一次資料

ブラウザへ配布するライブラリのライセンスとMediabunnyのソース入手先は、画面末尾と`apps/web/public/third-party-notices.txt`から確認できます。MediabunnyはMPL-2.0、Next.js／ReactはMITです。ライブラリのソースを改変せず利用し、上流の原文通知を保持します。依存更新時は通知も再確認し、KOKO自身のライセンス選定とは区別してください。[Mozillaの配布に関するFAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

- [Next.js App Router導入](https://nextjs.org/docs/app/getting-started/installation)
- [Next.jsとVitest](https://nextjs.org/docs/app/guides/testing/vitest)
- [Next.jsとPlaywright](https://nextjs.org/docs/app/guides/testing/playwright)
- [Mediabunnyの変換](https://mediabunny.dev/guide/converting-media-files)、[コピー制約](https://mediabunny.dev/api/ConversionCopyOptions)
