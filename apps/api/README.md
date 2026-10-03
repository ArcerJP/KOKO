# KOKO バックエンド

TypeScriptのCloudflare Workers APIと、その管理下にあるDB契約を置く領域です。[初期migration](supabase/migrations/20260921000000_initial_contract.sql)に加え、Workerの安全な最小基盤を実装しています。初期SQLはKOKO開発DBへ適用済みです。`/me`はローカルWorkerと実Google JWT・開発DBによる取得・表示名変更・拒否経路まで検証済みです。2026-10-03にWorkerのSupabase設定を登録し、10月4日に`/me`を含むmainを既存開発Workerへ配備しました。配備後の保護・health・401を確認し、本人の実Googleログイン試験で外部WorkerとSupabaseの読取り／未所属403経路の受入も成功しました。クラウド側の所属あり取得・更新は未検証です。[最新の配備結果](../../docs/product/cloud-setup.md#r2修正後の単回配備2026-10-04)を参照してください。メディア操作APIも未実装です。

## Worker基盤

- Worker名：`koko-api-dev`
- 開発Workerへ配備済みの処理：`GET /health`、Bearer認証の`GET /me`と`PATCH /me`。全URLをCloudflare Accessで保護し、一般公開した意味ではありません。実クラウドでは読取り／未所属拒否まで受入済みで、所属ありの取得・更新は未検証です。
- 本人情報API：Supabase Authで本人を検証し、Google単独ログインとイベント所属を確認した後、WorkerだけがDB Secretを使用します。`POST /consents`は下記のローカル実装を追加しましたが未配備です。Cookie認証・CSRFトークンの発行は未実装です。
- 未定義route：JSONの404
- `/health`へのGET以外のmethod：JSONの405
- R2 binding：`ORIGINALS_BUCKET`と`DERIVED_BUCKET`

R2 bindingは[Wrangler設定](wrangler.jsonc)へ定義していますが、現在のハンドラーはR2を読み書きしません。認証・認可・投稿状態の確認を実装する前に、原本や派生物を返すrouteを追加しないでください。`wrangler dev`とテストは既定でローカルR2を使用し、開発用実バケットへ接続しません。

`/me`は`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`がそろわなければ失敗させます。値をソースや`wrangler.jsonc`へ書かず、クラウドの登録・更新は[配備Skill](../../.agents/skills/api-deployment/SKILL.md)に従い本人が入力します。SecretはRLSを回避するため、ブラウザ・Webの`NEXT_PUBLIC_`変数に渡しません。利用者JWTはURLに載せず、Workerへは`Authorization: Bearer`だけで渡します。実試験の一時イベント・本人所属は削除済みで、正式イベント・所属の登録や同意保存を済ませたという意味ではありません。

## 現行規約の同意保存（ローカル実装）

`POST /consents`は既存の[API契約](../../packages/contract/openapi.yaml)に従い、`X-Event-ID`とGoogle単独のBearer認証、イベント所属を確認します。入力は`terms_version`と`accepted: true`だけのJSONです。本文は1KiBまでとし、不正JSON・UTF-8・余分な属性・空版を拒否します。本人IDや同意日時をクライアントに指定させません。Cookieだけでは認証せず、CSRF未実装の書込み経路を開けません。

[追加migration](supabase/migrations/20261004000000_accept_current_terms.sql)の`accept_current_terms`が、イベントの現行版確認・所属の再照合・保存を1 transactionで実行します。規約版の行は`FOR SHARE`、所属行は`FOR KEY SHARE`で保持し、別リクエストで版を読んでから保存する競合を避けます。DBの`accepted_at`既定値で日時を記録し、同じ本人・イベント・版の再送は重複挿入せず、最初の日時を残します。規約更新後も旧版の同意履歴を上書きしません。BAN中の同意は投稿制限の解除を意味せず、BAN状態を変更しません。

関数は`SECURITY INVOKER`・空の`search_path`とし、`PUBLIC`・`anon`・`authenticated`の実行権限を取り消し、既存の`service_role`だけへ許可します。Workerは検証済み本人IDだけをRPCへ渡します。成功は200の`request_id`、旧版は403 `CONSENT_REQUIRED`、所属消失は403 `FORBIDDEN`です。RPC未適用・未知の応答・上流障害は500 `INTERNAL_ERROR`に閉じ、redirectを追わず、生応答・資格情報を返しません。

**追加migrationは実Supabase未適用、同意APIは未配備です。** 既存初期SQL、正式な規約・イベント・所属・同意は変更していません。ローカルのPGliteは関数実行・権限・版更新・再送・transaction取消しを検証しますが、単一接続のため実PostgreSQLの多接続競合試験とは区別します。Worker試験の上流はmockであり、実RPC・Google・Cookie／CSRF・FE画面の通し試験は後続です。

実適用時は別途本人確認のうえ、追加migrationと権限・schema cacheの反映を確認してからWorkerを配備します。migrationにはPostgRESTのschema cache更新通知を含めています。失敗時に旧版の直接INSERTへ迂回したり、既存同意を削除して再実行したりしません。正式規約の内容・版の採択は運営の確認事項です。

根拠：[PostgREST RPC](https://docs.postgrest.org/en/stable/references/api/functions.html)、[Supabaseの関数権限](https://supabase.com/docs/guides/database/functions)、[PostgreSQLの行ロック](https://www.postgresql.org/docs/current/explicit-locking.html)（2026-10-04確認）。

## ローカル検証

リポジトリルートで次を実行します。

```powershell
npm.cmd run typecheck:api
npm.cmd run test:contract
npm.cmd run test:api
npm.cmd run build:api
npm.cmd run test:deploy-workflow
```

`build:api`は`wrangler deploy --dry-run`を使うため、bundleを検証しますがCloudflareへアップロードしません。bindingまたはcompatibility dateを変えた場合は、`npm.cmd run types --workspace @koko/api`で[生成型](src/worker-configuration.d.ts)を更新してください。CIは`types:check`で差分を検出します。

Wrangler 4.147.0には未指定R2 jurisdictionを削除差分として扱う不具合があるため、`prebuild`と`predeploy`で[限定互換修正](../../.github/scripts/patch-wrangler-r2.mjs)を適用します。対象版・CLI全体のhashが一致しなければ停止し、`--strict`や実設定差分の拒否は維持します。通常のroot commandから実行し、npm lifecycleを省略しないでください。確認だけは`node .github/scripts/patch-wrangler-r2.mjs --check`（root）で行えます。採用理由・更新/解除・不一致時の対応は[CI規約](../../docs/ci.md#wrangler-r2未指定値の限定互換修正)を参照してください。修正後の単回配備成功と残る受入は上記の最新記録へ集約します。

通常の実配備は[配備Skill](../../.agents/skills/api-deployment/SKILL.md)に従いGitHub Actionsから実行します。ローカルの`npm.cmd run deploy --workspace @koko/api`もCloudflareへ書き込むため、別途承認された用途だけに使用し、Actionsのガード・診断失敗の迂回に使いません。APIトークンやaccount IDをリポジトリへ追加しません。

書込みを個別Workerへ限定したAccount API Tokenで、GitHub Actionsへの移行・初回手動配備・通常main更新による自動配備は確認済みです。現在の停止状態、追加した読取り権限、残る検証は[クラウドの最新記録](../../docs/product/cloud-setup.md#2026-10-03の配備障害と再発防止)、実行条件は[CIの配備境界](../../docs/ci.md#開発用api配備)を参照してください。

## 新しい環境へ初期SQLを適用する前に

1. [第0日契約](../../docs/product/day-zero.md)のレビュー承認を得る。
2. 対象が本番ではなく意図した開発DBであること、バックアップ/初期状態を確認する。
3. Supabase管理の`auth.users`、`auth.uid()`、`anon`/`authenticated`/`service_role`が存在する環境へ適用する。テストfixtureのauthスキーマを実環境へコピーしない。
4. 実Google JWTと役割を使って匿名・本人・他人・別イベント・管理者・service_roleを検証する。
5. 適用後の修正は新migration。初期SQLの編集で適用済みDBも変わったとは扱わない。

初期値は公開停止・受付停止です。閾値を校正し、人間の公開判断があるまで解除しません。一般利用者に直接書込み権限はなく、原本キー・処理状態・ログはAPI認可を通します。`service_role`はRLSを回避するため、秘密の保護とWorker側の認可が必須です。

KOKO開発DBでは初期SQLの適用、ロール・IDを模擬したRLS試験、実Google JWTとローカルAPIを使う本人情報の結合試験を確認しています。別の実アカウント、全テーブルの全操作、Next.js画面からの通し試験は未検証です。日付付きの証拠・試験範囲と制約は[確認結果](../../docs/product/cloud-setup.md#3-supabasedb認証)を参照してください。

状態更新・counter・監査・outboxのtransaction責務、webhookの重複/順不同、BAN/削除との競合は[共有契約](../../packages/contract/README.md)に従います。Workers向けbuildと実行環境テストは導入済みです。入力/認可/DB統合テストは該当機能と同時に、Cloud Runコンテナのbuildは画像処理の実装と同時に追加します。詳細は[BEタスク](../../docs/product/development-plan.md#beタスク)を参照してください。
