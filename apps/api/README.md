# KOKO バックエンド

TypeScriptのCloudflare Workers APIと、その管理下にあるDB契約を置く領域です。[初期migration](supabase/migrations/20260921000000_initial_contract.sql)に加え、Workerの安全な最小基盤を実装しています。初期SQLはKOKO開発DBへ適用済みです。`/me`はローカルWorkerと実Google JWT・開発DBによる取得・表示名変更・拒否経路まで検証済みです。2026-10-03にWorkerのSupabase設定を登録し、10月4日に`/me`を含むmainを既存開発Workerへ配備しました。配備後の保護・health・401を確認し、本人の実Googleログイン試験で外部WorkerとSupabaseの読取り／未所属403経路の受入も成功しました。クラウド側の所属あり取得・更新は未検証です。[最新の配備結果](../../docs/product/cloud-setup.md#r2修正後の単回配備2026-10-04)を参照してください。アップロード受付は下記の既定無効なローカル実装までで、保存完了・閲覧配信APIは未実装です。

## Worker基盤

- Worker名：`koko-api-dev`
- 開発Workerへ配備済みの処理：`GET /health`、Bearer認証の`GET /me`と`PATCH /me`。全URLをCloudflare Accessで保護し、一般公開した意味ではありません。実クラウドでは読取り／未所属拒否まで受入済みで、所属ありの取得・更新は未検証です。
- 本人情報API：Supabase Authで本人を検証し、Google単独ログインとイベント所属を確認した後、WorkerだけがDB Secretを使用します。`POST /consents`と既定無効のCookie認証・CSRF受信境界は下記のローカル実装を追加しましたが未配備です。Cookie発行・更新・削除のWeb内部処理と表示名/規約同意画面は既定無効の条件付き実装で、実環境へ未接続です。
- 未定義route：JSONの404
- `/health`へのGET以外のmethod：JSONの405
- R2 binding：`ORIGINALS_BUCKET`と`DERIVED_BUCKET`

R2 bindingは[Wrangler設定](wrangler.jsonc)へ定義しています。配備済みハンドラーと既定無効の受付ではR2を操作しません。下記の受付を明示的に有効化した場合のみ、認可後にmultipartを開始します。原本や派生物を返すrouteはありません。`wrangler dev`とテストは既定でローカルR2を使用し、開発用実バケットへ接続しません。

`/me`は`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`がそろわなければ失敗させます。値をソースや`wrangler.jsonc`へ書かず、クラウドの登録・更新は[配備Skill](../../.agents/skills/api-deployment/SKILL.md)に従い本人が入力します。SecretはRLSを回避するため、ブラウザ・Webの`NEXT_PUBLIC_`変数に渡しません。利用者JWTはURLに載せません。配備済みWorkerは`Authorization: Bearer`のみで、未配備のCookie経路は下記の明示設定が必要です。実試験の一時イベント・本人所属は削除済みで、正式イベント・所属の登録や同意保存を済ませたという意味ではありません。

## Cookie認証とCSRF（既定無効のローカル実装）

[account-auth.ts](src/account-auth.ts)はWeb用の受信境界です。Supabase SSR CookieやCloudflare Access Cookieを利用者認証へ自動転用せず、`__Host-koko_session`という単一Cookieだけを扱います。値は加工していないSupabase access JWTで、chunk分割・引用符・URLエンコードには対応しません。Cookie headerは16KiB、tokenは8KiB以内です。重複やBearerとの併送は401で拒否し、不正BearerからCookieへfallbackしません。既存Bearer経路はCookie用設定に依存せず、`GET /me`へCSRFを追加しません。

以下は将来の有効化条件であり、**今回値を生成・登録したり、Wrangler設定を変更したりしていません。**

| 設定               | 受信条件                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `KOKO_WEB_ORIGIN`  | 単一の正規化済みHTTPS origin。末尾slash・path・query・fragment・認証情報なし。実URLは未決定                     |
| `KOKO_CSRF_SECRET` | 独立した暗号学的乱数32byteを64桁hexで表す専用Secret。Supabase鍵やAccess tokenを再利用せず、サーバー外へ渡さない |

両方未設定ならCookie経路は無効（401）、片方だけ・不正設定なら500に閉じます。HTTPS以外を拒否し、指定された`Origin`は設定値と完全一致が必要です。`PATCH /me`・`POST /consents`と有効化時のアップロード3操作ではOriginが必須で、Host／X-Forwarded-Host／Refererから補完しません。`Sec-Fetch-Site`があれば`same-origin`だけを許可します（GETでは`none`も許可）。同headerがないブラウザでも書込みのOriginとCSRFは省略しません。CORSを有効化せず、有効routeのOPTIONSは405です（受付flag無効のrouteは404）。

### セッションに結び付けたCSRF

1. `GET /me`は毎回Supabase AuthでJWTを照合し、Google単独・イベント所属・本人情報取得がすべて成功した場合だけ`csrf_token`を返します。
2. 値は`v1.<16byteの乱数を32桁hex化したnonce>.<HMAC-SHA256のbase64url>`。MAC入力はUTF-8の`JSON.stringify(["koko.csrf.v1", 設定origin, eventId, accessJWT, nonce])`です。JWTや鍵そのものを応答へ返しません。
3. Cookie書込みでは`X-CSRF-Token`の形式・正規base64urlとMACをWeb Cryptoで検証してからAuth/DBへ進みます。CSRFだけでは認証せず、書込み時も本人・Google・所属を再確認します。成功・エラーとも非キャッシュです。
4. JWT更新、イベント・origin・鍵の変更後は以前のCSRFを使えません。再GETした複数のCSRFは同じセッション内で併用できます。nonceを使い捨てや同意の証明とは扱いません。

有効期間はSupabaseが当該JWTを受理する期間に依存し、独立したCSRF期限は設けません。ログアウト直後のJWT即時失効を保証するものではなく、実際の失効挙動は未受入です。CSRFをURL・ログ・永続ストレージ・共有cacheへ保存せず、ログアウト時にはクライアントのメモリからも破棄します。CSRF用Cookieを併用する方式ではありません。

### 未実装・実接続前の条件

発行側の正本は[WebのAPI用Cookie処理](../web/README.md#api用cookieの発行処理既定無効)です。callback・ログアウト・中継・表示名画面の操作時発行/更新は条件付きでローカル実装済みですが、実環境での有効化は未実施です。Web内部の世代付きCookieは中継で包みを外し、Workerには従来のraw JWTだけを送ります。Workerの受信契約は変更しません。受信Cookie headerだけではSecure・HttpOnly等の属性を検証できません。既存のSupabase SSRログインからコピーしただけで完成とは扱いません。

[本人情報3操作の同一origin中継](../web/README.md#本人情報の同一origin中継既定無効)をWeb側へ既定無効で追加しました。CookieとOriginの実伝搬、Accessとの両立、鍵の登録、実Google認証・refresh・logout・失効を確認してから有効化します。中継はJWT/CSRFの形式検査だけで、Workerの本人・所属・HMAC検証を代替しません。Secret登録・認証設定変更・実配備は[保護操作の個別確認](../../AGENTS.md#保護操作の確認)へ分離します。API境界の模擬試験は実ブラウザCookieや実クラウド受入を証明しません。

[試験](test/cookie-auth.spec.ts)はworkerdの実Web Cryptoと合成Auth/DB応答を使用し、独立したNode HMAC既知ベクトル、改竄・別session/event/origin/key、設定不足、重複Cookie、送信元偽装、認証・所属拒否、Bearer互換性を検証します。CSRFは悪意ある別サイトからの送信を制限するもので、XSSや漏洩したJWT・鍵への対策を代替しません。

根拠：[OWASPのCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Supabaseのサーバーでの本人照合](https://supabase.com/docs/reference/javascript/auth-getuser)（2026-10-04確認）。

## 現行規約の同意保存（ローカル実装）

`POST /consents`は既存の[API契約](../../packages/contract/openapi.yaml)に従い、`X-Event-ID`とGoogle単独認証、イベント所属を確認します。既定のBearer、または明示設定された上記Cookie＋Origin＋CSRF経路を使います。入力は`terms_version`と`accepted: true`だけのJSONです。本文は1KiBまでとし、不正JSON・UTF-8・余分な属性・空版を拒否します。本人IDや同意日時をクライアントに指定させません。Cookieだけで書込みを許可しません。

[追加migration](supabase/migrations/20261004000000_accept_current_terms.sql)の`accept_current_terms`が、イベントの現行版確認・所属の再照合・保存を1 transactionで実行します。規約版の行は`FOR SHARE`、所属行は`FOR KEY SHARE`で保持し、別リクエストで版を読んでから保存する競合を避けます。DBの`accepted_at`既定値で日時を記録し、同じ本人・イベント・版の再送は重複挿入せず、最初の日時を残します。規約更新後も旧版の同意履歴を上書きしません。BAN中の同意は投稿制限の解除を意味せず、BAN状態を変更しません。

関数は`SECURITY INVOKER`・空の`search_path`とし、`PUBLIC`・`anon`・`authenticated`の実行権限を取り消し、既存の`service_role`だけへ許可します。Workerは検証済み本人IDだけをRPCへ渡します。成功は200の`request_id`、旧版は403 `CONSENT_REQUIRED`、所属消失は403 `FORBIDDEN`です。RPC未適用・未知の応答・上流障害は500 `INTERNAL_ERROR`に閉じ、redirectを追わず、生応答・資格情報を返しません。

**追加migrationは実Supabase未適用、同意APIは未配備です。** 既存初期SQL、正式な規約・イベント・所属・同意は変更していません。ローカルのPGliteは関数実行・権限・版更新・再送・transaction取消しを検証しますが、単一接続のため実PostgreSQLの多接続競合試験とは区別します。Worker試験の上流はmockであり、実RPC・Google・Cookie／CSRF・FE画面の通し試験は後続です。

実適用時は別途本人確認のうえ、追加migrationと権限・schema cacheの反映を確認してからWorkerを配備します。migrationにはPostgRESTのschema cache更新通知を含めています。失敗時に旧版の直接INSERTへ迂回したり、既存同意を削除して再実行したりしません。正式規約の内容・版の採択は運営の確認事項です。[Web同意画面](../web/README.md#現行規約の明示同意画面本文未採択既定無効)は条件付きでローカル実装済みですが、採択本文の一覧は空であり、正式な同意受付を有効にしていません。

根拠：[PostgREST RPC](https://docs.postgrest.org/en/stable/references/api/functions.html)、[Supabaseの関数権限](https://supabase.com/docs/guides/database/functions)、[PostgreSQLの行ロック](https://www.postgresql.org/docs/current/explicit-locking.html)（2026-10-04確認）。

## 投稿受付のDB予約（B1-5、ローカル実装）

[追加migration](supabase/migrations/20261004010000_reserve_upload.sql)の`reserve_upload(event_id, user_id, request)`は、既存`UploadRequest`の申告内容を受け、投稿と原本資産の保存先を1 transactionで予約します。下記のHTTP受付・session RPCから呼び出します。内部RPCの結果は`UploadTicket`ではなく、原本キーを含むため利用者向け応答へそのまま返しません。**実Supabaseへの追加migration適用と実R2保存は未完了です。**

- WorkerがGoogle本人とCookie利用時のOrigin/CSRFを検証した後の内部呼出し専用です。`SECURITY INVOKER`・空`search_path`・`service_role`だけに実行権限を限定し、クライアント入力の本人IDを信用しません。
- イベント所属、BAN、`live`かつ開始以上・終了未満、受付有効、公開停止なし、現行規約への同意、お題の同一イベント・公開中・期間内を再照合します。再送でもこれらを省略しません。
- イベント/設定を共有ロックし、本人の所属行を排他ロックして、同じイベント・本人の予約を直列化します。同意、既存投稿、お題、原本資産も順に保持します。ロック順序はevent→settings→member→consent→post→theme→asset。`READ COMMITTED`以外では拒否し、将来の管理・BAN・complete実装でもロック順序と競合を検証します。
- 新規投稿は直近60秒の本人別件数で制限します。上限は10件で、設定による引下げは可能です。削除済み投稿もその期間の件数に含め、同じ受付IDの再送は追加枠を使いません。拒否時の`retry_after_seconds`は1〜60秒です。
- 初回入力を内部列`posts.upload_request`へ保存します。UUID表記と未指定/NULLのお題を正規化し、同じID・同じ内容なら同じ投稿/原本資産、異なる内容なら`IDEMPOTENCY_CONFLICT`です。後日のテーマ変更などから初回入力を再構成しません。旧行のNULL snapshot、`uploading`以外、BANラッチ、テーマ付替え・原本削除予約等は再発行せず閉じます。`upload_failed`からの回復は後続の明示処理です。
- サイズは申告値であり、`original_bytes`/`byte_size`を実測済みとして埋めません。形式のallowlistや業務独自の容量制限は追加せず、R2の実オブジェクト上限（5 TiB − 5 GiB）超だけを`PROVIDER_LIMIT`で拒否します。single PUT上限より大きい予約を受け付けても、multipartや転送成功を実装済みとは扱いません。

[SQL試験](../../packages/contract/test/upload-admission.test.mjs)は全migrationを順に適用し、権限・不正入力・別イベント/本人・同意/BAN/停止・お題・再送・quota・資産保存失敗時の原子的取消しを検証します。PGliteは単一接続なので、実PostgreSQLでの多接続競合・負荷試験は未完了です。

認証済みWorkerからのsession接続・再発行は下記を参照してください。次は実在/サイズ確認と処理予約・回収へ進めます。秘密登録・migrationの実適用・実配備・受付有効化は本人の個別確認が必要です。

根拠（2026-10-04確認）：[PostgreSQLの行ロック](https://www.postgresql.org/docs/current/explicit-locking.html)、[Supabase関数の実行権限](https://supabase.com/docs/guides/database/functions)、[R2の上限と脚注](https://developers.cloudflare.com/r2/platform/limits/)。

## R2アップロード署名（B1-5、ローカル実装）

[R2アダプター](src/r2-upload.ts)は原本のsingle PUT署名、multipart分割計画・開始・part PUT署名・中止を実装します。`POST /uploads`、refresh、partsは下記の既定無効なHTTP受付へ接続しました。**completeは未実装です。** 単体の署名成功やローカルR2試験を、実クラウドへの保存成功とは扱いません。

- 既存開発用`koko-dev-originals`専用です。呼出し元から任意のbucket・host・URL・key・methodを受けず、検証済みevent/post/assetのUUIDから共有契約の原本キーを生成します。派生物や閲覧用GET、DELETE、multipart完了を署名しません。
- 署名はAPI専用の`aws4fetch`固定依存を利用し、暗号処理の独自実装を避けます。`sign()`だけを使い、署名時の外部通信やライブラリの自動再試行を行いません。公開契約packageへ依存を持ち込みません。
- 単発は`content-type`と`if-none-match: *`を署名し、必須headerとして返します。既存原本の上書きは許可しません。再送で条件不成立になっても保存成功を推定せず、後続のcomplete/HEAD照合で判定します。Content-TypeはHTTPで表現できるASCII・前後空白なしに検証しますが、画像形式等のallowlistではありません。
- 64 MiB以下はsingle、それより大きければmultipartです。これは容量制限ではなく再送単位の選択です。partは基本8 MiB、大きなファイルではMiB単位で増やし、R2実上限まで最大10,000partに収めます。part署名は1要求1〜100件、重複なし・宣言サイズから計算した最終part以内に限定します。providerのupload IDはopaqueな単一query値としてエスケープします。
- 有効期限は呼出し元が認可済みsessionの期限から指定し、署名開始から最大900秒です。秒未満は切り下げ、期限を延長しません。期限切れ再発行でも本人・同意・BAN・停止・所有権・投稿状態の再照合が必要で、このアダプターは代替しません。既発行URLは期限内に再利用でき、後からBANしても即時失効できません。
- multipart開始結果はサーバー内部情報です。DBとR2は同一transactionではないため、下記sessionが作成権を予約してから呼びます。provider作成失敗を自動再試行しません。中止アダプターは既知の未採用session専用で、HTTP受付では結果不明の勝者を取り消さないよう呼びません。provider例外・秘密・URLをエラーやログへ含めません。

実接続時にはAPIサーバー専用の`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`と原本bucket限定資格情報が必要です。今回は値の取得/登録やWrangler設定変更をしていません。CORSは対象Web origin・PUT・singleの必須header・ETag取得を含め別途本人確認して設定し、任意originへ開放しません。署名URLにもアクセス能力があるため、チャット・ログ・DB・画像へ保存しません（upload sessionの期限/provider IDとは区別）。

[試験](test/r2-upload.spec.ts)はWorkersで実署名し、ライブラリを使わないSigV4検算、署名改竄、サイズ/part/期限境界、local R2の開始・再開・中止を検証します。ローカルR2 bindingはS3署名検証を行わないため、実S3 PUT・条件付き上書き拒否・CORS・ETag・実端末・大容量転送は未検証です。multipart完了の不変性、処理予約と孤児回収も後続です。

根拠（2026-10-05確認）：[R2署名URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[S3互換性のPutObject条件付き操作](https://developers.cloudflare.com/r2/api/s3/api/)、[R2実上限の脚注](https://developers.cloudflare.com/r2/platform/limits/)、[Workers multipart API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[公式aws4fetch例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)。

## アップロード受付と送信session（B1-5、既定無効）

[HTTP受付](src/uploads.ts)は`POST /uploads`・`POST /uploads/{upload_id}/refresh`・`POST /uploads/{upload_id}/parts`を接続します。`KOKO_UPLOADS_ENABLED`が文字列`true`の場合だけ有効で、それ以外は404・上流接続なしです。Wranglerへflagや秘密の値は追加していません。**実DB適用、原本bucket限定資格情報、CORS、complete/HEAD・回収の実装と受入がそろうまで実受付を有効化しません。** Web側の送信UI・同一origin中継も後続です。

- [共通認証](src/api-context.ts)で既存本人情報と同じGoogle本人照合を使い、Cookie書込みはOrigin/CSRFを必須にします。本人IDはAuth応答からのみ取得し、DBで所属・現行同意・BAN・停止・お題・投稿状態を毎回再確認します。Content-Type、最大4KiB・厳格UTF-8のJSON、追加属性、サイズ、part指定を検査します。refreshは本文を受けません。
- [追加migration](supabase/migrations/20261005010000_upload_sessions.sql)の内部`manage_upload_session`は`open/refresh/parts/attach`を扱います。`reserve_upload`のlock順序の後でsessionをlockし、`UNIQUE(event_id, post_id)`で1投稿1sessionを保証します。既存に重複行があればmigrationは失敗させ、データを自動削除しません。単発送信は同じtransactionでreadyになります。
- multipartは新規winnerだけが`provisioning`となり、Worker生成attempt UUIDでR2作成権を束縛します。R2開始後に`attach`がguardを再照合してprovider IDを保存し、readyへ変更します。同じattempt/providerのattachは冪等で、別値への変更は拒否します。内部provider ID・原本キー・申告snapshotをAPI本文へ丸ごと返さず、既存`UploadTicket`だけを組み立てます（part署名URL内のopaque provider IDはプロトコル上必要です）。
- 同じリクエストの再送とrefreshは同じ投稿/session/providerを使い、新しいmultipartを作りません。期限はDB時刻から15分以内かつイベント/お題終了以下、秒単位切下げです。partsでは期限を延長せず、期限切れは`UPLOAD_EXPIRED`。refreshは期限切れでも未完了・本人・guardを再確認して更新します。完了session、削除/BANラッチ済み投稿へは再発行しません。
- DB予約の応答喪失・R2作成結果不明・作成後crashではprovisioningが残ることがあります。同じ/別attemptの再送でも自動的に作成し直さず`UPLOAD_INCOMPLETE`で保留します。attach応答だけ失われた場合は後のopenでreadyを取得できます。結果不明のproviderを盲目的にabortしません。lease takeoverは未知の旧作成との重複を招くため採用していません。**保留/孤児の自動回収、provider側失効・中止後の回復は未実装**であり、無期限の自動回復を保証しません。
- DB/R2応答の不正・redirect・不明エラーを閉じ、秘密や生応答を返しません。成功・失敗とも`private, no-store`。DBの期限検査と署名を経ても、すでに発行したURLの即時失効は保証しません。単発の実サイズ・multipartの実在/最終サイズは後続のcomplete/HEADが判定します。

[session SQL試験](../../packages/contract/test/upload-sessions.test.mjs)は全migrationをメモリDBへ適用して権限・所有者・単一winner・期限・guard更新・保存失敗の取消しを検証します。[HTTP試験](test/uploads.spec.ts)はWorkers上の実署名と模擬Auth/RPC/provider応答で受付・再発行・part・CSRF・応答不明を検証します。実PostgreSQLの多接続競合、実PostgRESTからR2までの通し試験、実配備は未実施です。

根拠（2026-10-05確認）：[PostgreSQLの行lock](https://www.postgresql.org/docs/current/explicit-locking.html)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)（resume自体はprovider uploadの実在を確認しません）。

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
