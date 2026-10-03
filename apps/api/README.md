# KOKO バックエンド

TypeScriptのCloudflare Workers APIと、その管理下にあるDB契約を置く領域です。[初期migration](supabase/migrations/20260921000000_initial_contract.sql)に加え、Workerの安全な最小基盤を実装しています。初期SQLはKOKO開発DBへ適用済みです。`/me`はローカルWorkerと実Google JWT・開発DBによる取得・表示名変更・拒否経路まで検証済みです。この実装の外部配備とクラウド用の秘密設定は未実施です。メディア操作APIも未実装です。

## Worker基盤

- Worker名：`koko-api-dev`
- 公開済みの処理：`GET /health`
- ローカル実装のみ：Bearer認証の`GET /me`と`PATCH /me`。Supabase Authで本人を検証し、Google単独ログインとイベント所属を確認した後、WorkerだけがDB Secretを使用します。Cookie認証・CSRFトークンの発行、`POST /consents`は未実装です。
- 未定義route：JSONの404
- `/health`へのGET以外のmethod：JSONの405
- R2 binding：`ORIGINALS_BUCKET`と`DERIVED_BUCKET`

R2 bindingは[Wrangler設定](wrangler.jsonc)へ定義していますが、現在のハンドラーはR2を読み書きしません。認証・認可・投稿状態の確認を実装する前に、原本や派生物を返すrouteを追加しないでください。`wrangler dev`とテストは既定でローカルR2を使用し、開発用実バケットへ接続しません。

`/me`は`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`がそろわなければ失敗させます。値をソースや`wrangler.jsonc`へ書かず、外部配備を別途承認・準備するまではクラウドへ設定しません。SecretはRLSを回避するため、ブラウザ・Webの`NEXT_PUBLIC_`変数に渡しません。利用者JWTはURLに載せず、Workerへは`Authorization: Bearer`だけで渡します。実試験の一時イベント・本人所属は削除済みで、正式イベント・所属の登録や同意保存を済ませたという意味ではありません。

## ローカル検証

リポジトリルートで次を実行します。

```powershell
npm.cmd run typecheck:api
npm.cmd run test:api
npm.cmd run build:api
npm.cmd run test:deploy-workflow
```

`build:api`は`wrangler deploy --dry-run`を使うため、bundleを検証しますがCloudflareへアップロードしません。bindingまたはcompatibility dateを変えた場合は、`npm.cmd run types --workspace @koko/api`で[生成型](src/worker-configuration.d.ts)を更新してください。CIは`types:check`で差分を検出します。

実deployは`npm.cmd run deploy --workspace @koko/api`です。このコマンドはCloudflareへ変更を反映するため、対象account・Worker・差分・認証状態を確認した承認済みのdeployだけに使用します。APIトークンやaccount IDをリポジトリへ追加しません。

個別Worker限定のAccount API Tokenを使うGitHub Actionsへの移行、初回手動配備、通常main更新による自動配備は確認済みです。残る外部設定・検証は[CIの配備境界](../../docs/ci.md#開発用api配備)と[クラウドの確認済み進捗](../../docs/product/cloud-setup.md#項目別の進捗2026-10-02更新)を参照してください。

## 新しい環境へ初期SQLを適用する前に

1. [第0日契約](../../docs/product/day-zero.md)のレビュー承認を得る。
2. 対象が本番ではなく意図した開発DBであること、バックアップ/初期状態を確認する。
3. Supabase管理の`auth.users`、`auth.uid()`、`anon`/`authenticated`/`service_role`が存在する環境へ適用する。テストfixtureのauthスキーマを実環境へコピーしない。
4. 実Google JWTと役割を使って匿名・本人・他人・別イベント・管理者・service_roleを検証する。
5. 適用後の修正は新migration。初期SQLの編集で適用済みDBも変わったとは扱わない。

初期値は公開停止・受付停止です。閾値を校正し、人間の公開判断があるまで解除しません。一般利用者に直接書込み権限はなく、原本キー・処理状態・ログはAPI認可を通します。`service_role`はRLSを回避するため、秘密の保護とWorker側の認可が必須です。

KOKO開発DBでは初期SQLの適用、ロール・IDを模擬したRLS試験、実Google JWTとローカルAPIを使う本人情報の結合試験を確認しています。別の実アカウント、全テーブルの全操作、Next.js画面からの通し試験は未検証です。日付付きの証拠・試験範囲と制約は[確認結果](../../docs/product/cloud-setup.md#3-supabasedb認証)を参照してください。

状態更新・counter・監査・outboxのtransaction責務、webhookの重複/順不同、BAN/削除との競合は[共有契約](../../packages/contract/README.md)に従います。Workers向けbuildと実行環境テストは導入済みです。入力/認可/DB統合テストは該当機能と同時に、Cloud Runコンテナのbuildは画像処理の実装と同時に追加します。詳細は[BEタスク](../../docs/product/development-plan.md#beタスク)を参照してください。
