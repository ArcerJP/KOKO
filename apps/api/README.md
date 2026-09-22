# KOKO バックエンド

TypeScriptのCloudflare Workers APIと、その管理下にあるDB契約を置く領域です。[初期migration](supabase/migrations/20260921000000_initial_contract.sql)に加え、Workerの安全な最小基盤を実装しています。実環境のSupabase設定、認証、メディア操作APIは未実装です。

## Worker基盤

- Worker名：`koko-api-dev`
- 公開済みの処理：`GET /health`
- 未定義route：JSONの404
- `GET /health`以外のmethod：JSONの405
- R2 binding：`ORIGINALS_BUCKET`と`DERIVED_BUCKET`

R2 bindingは[Wrangler設定](wrangler.jsonc)へ定義していますが、現在のハンドラーはR2を読み書きしません。認証・認可・投稿状態の確認を実装する前に、原本や派生物を返すrouteを追加しないでください。`wrangler dev`とテストは既定でローカルR2を使用し、開発用実バケットへ接続しません。

## ローカル検証

リポジトリルートで次を実行します。

```powershell
npm.cmd run typecheck:api
npm.cmd run test:api
npm.cmd run build:api
```

`build:api`は`wrangler deploy --dry-run`を使うため、bundleを検証しますがCloudflareへアップロードしません。bindingまたはcompatibility dateを変えた場合は、`npm.cmd run types --workspace @koko/api`で[生成型](src/worker-configuration.d.ts)を更新してください。CIは`types:check`で差分を検出します。

実deployは`npm.cmd run deploy --workspace @koko/api`です。このコマンドはCloudflareへ変更を反映するため、対象account・Worker・差分・認証状態を確認した承認済みのdeployだけに使用します。APIトークンやaccount IDをリポジトリへ追加しません。

## SQLを適用する前に

1. [第0日契約](../../docs/product/day-zero.md)のレビュー承認を得る。
2. 対象が本番ではなく意図した開発DBであること、バックアップ/初期状態を確認する。
3. Supabase管理の`auth.users`、`auth.uid()`、`anon`/`authenticated`/`service_role`が存在する環境へ適用する。テストfixtureのauthスキーマを実環境へコピーしない。
4. 実Google JWTと役割を使って匿名・本人・他人・別イベント・管理者・service_roleを検証する。
5. 適用後の修正は新migration。初期SQLの編集で適用済みDBも変わったとは扱わない。

初期値は公開停止・受付停止です。閾値を校正し、人間の公開判断があるまで解除しません。一般利用者に直接書込み権限はなく、原本キー・処理状態・ログはAPI認可を通します。`service_role`はRLSを回避するため、秘密の保護とWorker側の認可が必須です。

状態更新・counter・監査・outboxのtransaction責務、webhookの重複/順不同、BAN/削除との競合は[共有契約](../../packages/contract/README.md)に従います。Workers向けbuildと実行環境テストは導入済みです。入力/認可/DB統合テストは該当機能と同時に、Cloud Runコンテナのbuildは画像処理の実装と同時に追加します。詳細は[BEタスク](../../docs/product/development-plan.md#beタスク)を参照してください。
