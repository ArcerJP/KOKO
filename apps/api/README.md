# KOKO バックエンド

TypeScriptのCloudflare Workers APIと、その管理下にあるDB契約を置く領域です。投稿受付/原本保存、画像/動画処理、認証付きフィード/配信、運営操作/個別原本取得、通知/監視を下記の既定無効なローカル実装として接続しています。実配備・受入済みなのは基盤部分に限られます。

[初期migration](supabase/migrations/20260921000000_initial_contract.sql)はKOKO開発DBへ適用済みです。`/me`はローカルWorkerと実Google JWT・開発DBによる取得・表示名変更・拒否経路まで検証済み。2026-10-04の開発配備後、保護・health・401と、本人の実Googleログインによる外部Worker/Supabase読取り・未所属403を受け入れました。クラウド側の所属あり取得・更新と追加機能の実保存/配信は未受入です。[最新の配備結果](../../docs/product/cloud-setup.md#r2修正後の単回配備2026-10-04)を参照してください。

## Worker基盤

- Worker名：`koko-api-dev`
- 開発Workerへ配備済みの処理：`GET /health`、Bearer認証の`GET /me`と`PATCH /me`。全URLをCloudflare Accessで保護し、一般公開した意味ではありません。実クラウドでは読取り／未所属拒否まで受入済みで、所属ありの取得・更新は未検証です。
- 本人情報API：Supabase Authで本人を検証し、Google単独ログインとイベント所属を確認した後、WorkerだけがDB Secretを使用します。`POST /consents`と既定無効のCookie認証・CSRF受信境界は下記のローカル実装を追加しましたが未配備です。Cookie発行・更新・削除のWeb内部処理と表示名/規約同意画面は既定無効の条件付き実装で、実環境へ未接続です。
- 未定義route：JSONの404
- `/health`へのGET以外のmethod：JSONの405
- R2 binding：`ORIGINALS_BUCKET`と`DERIVED_BUCKET`

R2 bindingは[Wrangler設定](wrangler.jsonc)へ定義しています。配備済みハンドラーと既定無効の受付ではR2を操作しません。下記の受付を明示的に有効化した場合のみ、認可後にmultipartを開始します。原本/派生物を返す認証routeも下記のローカル実装に追加しましたが、未有効化・未配備です。`wrangler dev`とテストは既定でローカルR2を使用し、開発用実バケットへ接続しません。

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

## 初回イベント参加（B1-4、既定無効）

[enrollment.ts](src/enrollment.ts)と[追加migration](supabase/migrations/20261006010000_event_enrollment.sql)は、Googleログイン済み・イベント未所属の利用者が表示名を明示して参加する専用経路です。既存`/me`等の未所属拒否や役割・同意の検査は緩めません。実DB適用・設定・配備・Web画面の通し受入は未実施です。

- **固定対象と既定OFF**：`KOKO_ENROLLMENT_ENABLED`が文字列`true`、`KOKO_EVENT_ID`がUUIDの場合だけ有効。ヘッダー`X-Event-ID`は固定値と一致が必須です。後者はWebと同じ設定名で、任意イベントへ加入できるAPIではありません。Wranglerや実クラウドへ設定は追加していません。
- **読取りpreflight**：`GET /me/enrollment`はGoogle本人を検証後、service限定の`read_event_enrollment`を呼びます。本人/event ID、`enrolled`、`registration_open`だけを明示投影し、Cookieの場合だけ既存HMACのセッション/event束縛CSRFを追加。プロフィール・役割・BAN・秘密は返さず、DBへ書きません。未所属者が従来`GET /me`でCSRFを取得できない循環を、この限定読取り経路で解消します。CSRFは所属・参加・同意の証明ではありません。
- **明示的な初回登録**：`POST /me/enrollment`は`display_name`だけのJSONを受けます。CookieのOrigin/CSRFは従来どおり必須。Supabaseが検証した本人と固定eventだけを`enroll_event`へ渡し、role=user、BANなし、crown=none、counter=0で初回行を作ります。既存memberは入力名が異なっても更新せず、BAN/role/同意や日時を戻しません。成功後は`GET /me`を再取得し、必要な規約同意は従来`POST /consents`で別途行います。
- **初回受付条件**：既存投稿予約と同じ`live`・開始以上/終了未満・`uploads_enabled=true`・公開停止なし。開催前の新規所属を別途許可する仕様は追加しません。Googleログイン自体は参加とは別で、開会前の通し試験は承認済み開発イベントの期間・設定で行います。既所属者は期間終了/停止/BAN中もpreflight可能で、登録再送は不変の成功です。`registration_open=false`は既参加、または初回受付停止を意味します。
- **SQL境界**：2関数は`SECURITY DEFINER`・空`search_path`で、PUBLIC/anon/authenticatedの実行権限を剥奪しservice_roleだけへ付与。登録はREAD COMMITTED、event→settings→memberのlock順序、複合一意制約と`ON CONFLICT DO NOTHING`で再送/競合を安全側に扱います。規約同意・投稿・外部操作は作りません。行挿入が抑止された場合は成功とせずrollbackします。
- **通信制限**：query/余分な属性/不正UTF-8/制御文字/format文字・50文字超を拒否。入力1KiB・上流JSON16KiB・全体10秒、固定Supabase経路、redirect禁止、自動再送なし。応答不明でもDB保存済みの可能性があるため、失敗を未登録と断定しません。すべて`private, no-store`、CSRFや本文をログへ出しません。

[SQL試験](../../packages/contract/test/enrollment.test.mjs)と[HTTP試験](test/enrollment.spec.ts)は、service限定権限・初回/既存・停止/期間・再送・rollback、固定event/本人、Cookie/CSRF、秘密非出力、期限を検証します。PGliteの同一接続による再送試験を実PostgreSQL多接続競合の証拠とは扱わず、実OAuth/Cloudflare Access・実DB/配備・Web/実機受入を後続ゲートへ残します。

## 投稿受付のDB予約（B1-5、ローカル実装）

[追加migration](supabase/migrations/20261004010000_reserve_upload.sql)の`reserve_upload(event_id, user_id, request)`は、既存`UploadRequest`の申告内容を受け、投稿と原本資産の保存先を1 transactionで予約します。下記のHTTP受付・session RPCから呼び出します。内部RPCの結果は`UploadTicket`ではなく、原本キーを含むため利用者向け応答へそのまま返しません。**実Supabaseへの追加migration適用と実R2保存は未完了です。**

- WorkerがGoogle本人とCookie利用時のOrigin/CSRFを検証した後の内部呼出し専用です。`SECURITY INVOKER`・空`search_path`・`service_role`だけに実行権限を限定し、クライアント入力の本人IDを信用しません。
- イベント所属、BAN、`live`かつ開始以上・終了未満、受付有効、公開停止なし、現行規約への同意、お題の同一イベント・公開中・期間内を再照合します。再送でもこれらを省略しません。
- イベント/設定を共有ロックし、本人の所属行を排他ロックして、同じイベント・本人の予約を直列化します。同意、既存投稿、お題、原本資産も順に保持します。ロック順序はevent→settings→member→consent→post→theme→asset。`READ COMMITTED`以外では拒否し、将来の管理・BAN・complete実装でもロック順序と競合を検証します。
- 新規投稿は直近60秒の本人別件数で制限します。上限は10件で、設定による引下げは可能です。削除済み投稿もその期間の件数に含め、同じ受付IDの再送は追加枠を使いません。拒否時の`retry_after_seconds`は1〜60秒です。
- 初回入力を内部列`posts.upload_request`へ保存します。UUID表記と未指定/NULLのお題を正規化し、同じID・同じ内容なら同じ投稿/原本資産、異なる内容なら`IDEMPOTENCY_CONFLICT`です。後日のテーマ変更などから初回入力を再構成しません。旧行のNULL snapshot、`uploading`以外、BANラッチ、テーマ付替え・原本削除予約等は再発行せず閉じます。`upload_failed`からの回復は後続の明示処理です。
- サイズは申告値であり、`original_bytes`/`byte_size`を実測済みとして埋めません。形式のallowlistや業務独自の容量制限は追加せず、R2の実オブジェクト上限（5 TiB − 5 GiB）超だけを`PROVIDER_LIMIT`で拒否します。single PUT上限より大きい予約を受け付けても、multipartや転送成功を実装済みとは扱いません。

[SQL試験](../../packages/contract/test/upload-admission.test.mjs)は全migrationを順に適用し、権限・不正入力・別イベント/本人・同意/BAN/停止・お題・再送・quota・資産保存失敗時の原子的取消しを検証します。PGliteは単一接続なので、実PostgreSQLでの多接続競合・負荷試験は未完了です。

認証済みWorkerからのsession接続・再発行、実在/サイズ確認・処理予約、保存済み原本の回復は下記を参照してください。秘密登録・migrationの実適用・実配備・受付有効化は本人の個別確認が必要です。

根拠（2026-10-04確認）：[PostgreSQLの行ロック](https://www.postgresql.org/docs/current/explicit-locking.html)、[Supabase関数の実行権限](https://supabase.com/docs/guides/database/functions)、[R2の上限と脚注](https://developers.cloudflare.com/r2/platform/limits/)。

## R2アップロード署名（B1-5、ローカル実装）

[R2アダプター](src/r2-upload.ts)は原本のsingle PUT署名、multipart分割計画・開始・part PUT署名・中止を実装します。`POST /uploads`、refresh、partsは下記の既定無効なHTTP受付へ接続しました。completeは下記の[原本検証・処理予約](#アップロード完了と原本検証b1-6既定無効)へ分離しています。単体の署名成功やローカルR2試験を、実クラウドへの保存成功とは扱いません。

- 既存開発用`koko-dev-originals`専用です。呼出し元から任意のbucket・host・URL・key・methodを受けず、検証済みevent/post/assetのUUIDから共有契約の原本キーを生成します。派生物や閲覧用GET、DELETE、multipart完了を署名しません。
- 署名はAPI専用の`aws4fetch`固定依存を利用し、暗号処理の独自実装を避けます。`sign()`だけを使い、署名時の外部通信やライブラリの自動再試行を行いません。公開契約packageへ依存を持ち込みません。
- 単発は`content-type`と`if-none-match: *`を署名し、必須headerとして返します。既存原本の上書きは許可しません。再送で条件不成立になっても保存成功を推定せず、後続のcomplete/HEAD照合で判定します。Content-TypeはHTTPで表現できるASCII・前後空白なしに検証しますが、画像形式等のallowlistではありません。
- 64 MiB以下はsingle、それより大きければmultipartです。これは容量制限ではなく再送単位の選択です。partは基本8 MiB、大きなファイルではMiB単位で増やし、R2実上限まで最大10,000partに収めます。part署名は1要求1〜100件、重複なし・宣言サイズから計算した最終part以内に限定します。providerのupload IDはopaqueな単一query値としてエスケープします。
- 有効期限は呼出し元が認可済みsessionの期限から指定し、署名開始から最大900秒です。秒未満は切り下げ、期限を延長しません。期限切れ再発行でも本人・同意・BAN・停止・所有権・投稿状態の再照合が必要で、このアダプターは代替しません。既発行URLは期限内に再利用でき、後からBANしても即時失効できません。
- multipart開始結果はサーバー内部情報です。DBとR2は同一transactionではないため、下記sessionが作成権を予約してから呼びます。provider作成失敗を自動再試行しません。中止アダプターは既知の未採用session専用で、HTTP受付では結果不明の勝者を取り消さないよう呼びません。provider例外・秘密・URLをエラーやログへ含めません。

実接続時にはAPIサーバー専用の`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`と原本bucket限定資格情報が必要です。今回は値の取得/登録やWrangler設定変更をしていません。CORSは対象Web origin・PUT・singleの必須header・ETag取得を含め別途本人確認して設定し、任意originへ開放しません。署名URLにもアクセス能力があるため、チャット・ログ・DB・画像へ保存しません（upload sessionの期限/provider IDとは区別）。

[試験](test/r2-upload.spec.ts)はWorkersで実署名し、ライブラリを使わないSigV4検算、署名改竄、サイズ/part/期限境界、local R2の開始・再開・中止を検証します。ローカルR2 bindingはS3署名検証を行わないため、実S3 PUT・条件付き上書き拒否・CORS・ETag・実端末・大容量転送は未検証です。multipart完了と処理予約は下記のローカル実装、未完了uploadの孤児回収は後続です。

根拠（2026-10-05確認）：[R2署名URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[S3互換性のPutObject条件付き操作](https://developers.cloudflare.com/r2/api/s3/api/)、[R2実上限の脚注](https://developers.cloudflare.com/r2/platform/limits/)、[Workers multipart API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[公式aws4fetch例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)。

## アップロード受付と送信session（B1-5、既定無効）

[HTTP受付](src/uploads.ts)は`POST /uploads`・`POST /uploads/{upload_id}/refresh`・`POST /uploads/{upload_id}/parts`を接続します。`KOKO_UPLOADS_ENABLED`が文字列`true`の場合だけ有効で、それ以外は404・上流接続なしです。Wranglerへflagや秘密の値は追加していません。**実DB適用、原本bucket限定資格情報、CORS、complete/HEAD・回復の実受入がそろうまで実受付を有効化しません。** Web側の送信UI・同一origin中継もローカル接続済みですが、実機/実サービスの受入は別です。

- [共通認証](src/api-context.ts)で既存本人情報と同じGoogle本人照合を使い、Cookie書込みはOrigin/CSRFを必須にします。本人IDはAuth応答からのみ取得し、DBで所属・現行同意・BAN・停止・お題・投稿状態を毎回再確認します。Content-Type、最大4KiB・厳格UTF-8のJSON、追加属性、サイズ、part指定を検査します。refreshは本文を受けません。
- [追加migration](supabase/migrations/20261005010000_upload_sessions.sql)の内部`manage_upload_session`は`open/refresh/parts/attach`を扱います。`reserve_upload`のlock順序の後でsessionをlockし、`UNIQUE(event_id, post_id)`で1投稿1sessionを保証します。既存に重複行があればmigrationは失敗させ、データを自動削除しません。単発送信は同じtransactionでreadyになります。
- multipartはwinnerだけが`provisioning`となり、Worker生成attempt UUIDと最大120秒のleaseでR2作成権を束縛します。R2開始後に`attach`がguardと世代/期限を再照合してprovider IDを保存し、readyへ変更します。ready後の同じattempt/providerのattachは冪等で、別値への変更は拒否します。内部provider ID・原本キー・lease・申告snapshotをAPI本文へ丸ごと返さず、既存`UploadTicket`だけを組み立てます（part署名URL内のopaque provider IDはプロトコル上必要です）。
- ready後の再送とrefreshは同じ投稿/session/providerを使い、新しいmultipartを作りません。期限はDB時刻から15分以内かつイベント/お題終了以下、秒単位切下げです。partsでは期限を延長せず、期限切れは`UPLOAD_EXPIRED`。refreshは期限切れでも未完了・本人・guardを再確認して更新します。完了session、削除/BANラッチ済み投稿へは再発行しません。
- DB予約の応答喪失・R2作成結果不明・作成後crashではprovisioningが残ることがあります。期限後の新attemptによるopenだけに再作成権を渡し、初回を含む最大3回で止めます。古い/期限切れ結果はattachせず、provider待機もleaseで打ち切ります。attachがDBに保存済みなら後のopenでreadyを再利用。旧provider作成が遅れて成功した孤児は残り得るため、結果不明のproviderを盲目的にabortしません。**上限到達、未知lease、ready providerの失効/中止後の自動再開、孤児の能動削除は未解消**です。元ファイルを残し、権限者がDB/providerを照合してから対象限定の修復を判断します。新しい投稿IDでの再投稿・DB reset・abortを自動実行しません。未完了multipartの7日破棄は別途本人設定が必要で、下記の保存済み原本の回復とは別です。
- DB/R2応答の不正・redirect・不明エラーを閉じ、秘密や生応答を返しません。成功・失敗とも`private, no-store`。DBの期限検査と署名を経ても、すでに発行したURLの即時失効は保証しません。単発の実サイズ・multipartの実在/最終サイズは下記のcomplete/HEADが判定します。

[session SQL試験](../../packages/contract/test/upload-sessions.test.mjs)は全migrationをメモリDBへ適用して権限・所有者・単一winner・期限・guard更新・保存失敗の取消しを検証します。[HTTP試験](test/uploads.spec.ts)はWorkers上の実署名と模擬Auth/RPC/provider応答で受付・再発行・part・CSRF・応答不明を検証します。実PostgreSQLの多接続競合、実PostgRESTからR2までの通し試験、実配備は未実施です。

根拠（2026-10-05確認）：[PostgreSQLの行lock](https://www.postgresql.org/docs/current/explicit-locking.html)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)（resume自体はprovider uploadの実在を確認しません）。

## アップロード完了と原本検証（B1-6、既定無効）

[POST /posts/{post_id}/complete](src/upload-completion.ts)は同じ`KOKO_UPLOADS_ENABLED`で既定無効です。Google本人・Cookie時のOrigin/CSRFを確認し、[内部RPC](supabase/migrations/20261005020000_complete_upload.sql)と[R2完了アダプター](src/r2-completion.ts)を接続します。入力は`upload_id`とmultipart時の`parts`だけで、本人ID・原本キー・実サイズは受け取りません。制御JSONは1MiBまで（メディア容量制限ではありません）、partsは1〜10,000件の連続した番号・R2の32桁MD5 ETagを正規化します。

1. `prepare`は所有者とevent/post/asset/sessionの所属、現行同意・BAN・受付/公開停止・お題を検証します。既存のlock順序を維持し、初回partsを固定します。同じ一覧は再送可能、異なる一覧は`IDEMPOTENCY_CONFLICT`。singleは内部で空一覧を記録します。準備だけでは投稿をuploadedにしません。
2. canonical keyをHEADし、multipartで未存在の場合だけDB保存済みprovider uploadをcompleteします。例外・応答不明でもHEADを再照合し、勝手な再作成・abort・削除はしません。サイズは初回申告と完全一致、multipartは固定partsからの合成ETag一致、完了応答がある場合はHEADとversion/ETag/サイズも一致させます。実測metadataのみを保存対象にします。MD5はR2互換照合用であり、安全性判定・SHA256・MIME検出ではありません。
3. `commit`でguardと投稿versionを再照合し、原本の実測byte_size/ETag/version、`uploaded`とversion加算、session完了、`process_media` outboxを同一transactionで確定します。outboxの一意keyはupload IDごとに固定し、挿入失敗なら更新全体を取消します。202は処理予約の受付であり、変換・判定・公開の成功ではありません。
4. 同じcompleteの再送は初回の202受領票（`PostStatus`形式）を返します。現在の処理状態を表す応答ではありません。期間終了・受付停止後も本人/所属/現行同意/BANを確認して確定済み受領票だけを再送し、R2操作・version加算・処理再登録をしません。削除済み/BANラッチは拒否します。未確定の場合は毎回期間・受付停止等を再確認します。

署名期限はPUTの有効期限です。completeは新しいURLを発行せず、期限を延長しません。署名期限後でもイベント/お題の受付中なら原本確認を受け付けます。保存済みでも受付終了やBAN等によりcommitできない原本、固定後の誤ETag、provisioning結果不明は自動で作り直さず、後続の回収/運用手順へ残します。原本は既存singleの条件付きPUTと1投稿1multipartで上書きを防ぎ、将来の処理consumerも記録したobject version/ETagを確認する必要があります。

**追加migrationは実DB未適用、completeは未配備。R2通知/定期照合・outbox配送・変換/公開consumerは下記のローカル実装までで、実Queue・購読・Cronは未設定です。未完了uploadの孤児回収と実環境の通し受入は未完了です。** [FE送信キュー](../web/README.md#端末内送信キューと投稿画面f1-5f2-1既定無効)もローカル実装済みですが、B1-6全体や原本保存の実受入が完了したとは扱いません。

[SQL試験](../../packages/contract/test/upload-completion.test.mjs)は全migration・service専用権限・再送・guard変化・実測不一致・outbox失敗時取消しを検証します。[HTTP試験](test/upload-completion.spec.ts)は上流mock、[R2試験](test/r2-completion.spec.ts)は公式ETagベクトルとローカルR2を使用します。固定Miniflareはpart ETagにランダム値を使うため、multipart試験だけ合成内容のMD5からlocal part識別子へ変換するfixtureを挟み、実ローカル組立てと最終HEADを検証します。本番コードのチェックは緩めません。実S3転送、多接続DB競合、Google/Accessを通した実受入は未検証です。

根拠（2026-10-05確認）：[R2 completeとHEAD](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[multipart ETag](https://developers.cloudflare.com/r2/objects/upload-objects/#etags)、[R2強整合性](https://developers.cloudflare.com/r2/reference/consistency/)、[WorkersのMD5互換処理](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。

## 保存済み原本の回復（B1-6、既定無効）

[回復Worker](src/upload-recovery.ts)はR2通知のQueue入口と、通知・complete申告の取りこぼしを補うscheduled入口を追加します。[追加migration](supabase/migrations/20261005030000_upload_recovery.sql)のservice専用RPCを経由し、上記completeと同じguard・原子確定・outbox重複排除へ合流します。公開HTTP routeや利用者JWTの代理生成は追加しません。

- **通知は照会のきっかけのみ**：設定したQueue名、R2 account、開発原本bucket、`PutObject`/`CompleteMultipartUpload`、UUIDのcanonical keyを照合します。通知本文の本人ID・size・ETag等は使いません。DBの既存予約から所有者・申告サイズ・固定partsを導出し、HEADの実測値を再照合します。本文中のaccountは署名ではなく、認証の境界はCloudflareのQueue配信とproducer権限です。任意利用者から当該Queueへ投入できる構成を許可しません。
- **R2はHEAD限定**：既知の単発送信、またはparts固定済みのmultipartについて、組立て済み原本だけを回復します。未存在時もcomplete/create/abort/deleteを呼びません。provisioning不明・未固定parts・誤ETagを推測で修復しません。変換・公開の成功や安全判定ではありません。
- **毎回の再認可**：内部`recover_upload`はevent/post/asset/sessionを照合し、DB導出のowner/partsで既存`complete_upload`へ委譲します。prepare/commit間のBAN・規約変更・受付停止等も再検査します。API先行・通知先行・応答喪失後の再送は同じ受領票へ合流し、処理jobを追加登録しません。保留・削除投稿の復活や受付終了の迂回をしません。
- **件数限定の定期照合**：`claim_upload_recovery(10)`は5分以上前の未完了ready sessionを最大10件取得します。singleまたはparts固定済みmultipartで、uploading・BANラッチなし・原本削除予約なしが対象です。`READ COMMITTED`、session行の`SKIP LOCKED`、同transactionでの`recovery_after`の5分繰下げにより同時claimと連続再取得を抑制します。失敗・応答喪失も5分後に再候補となり、古い未保存原本だけが先頭を占有しない順序にします。これ自体は完了・排他lease・厳密な一度だけ処理の保証ではありません。
- **再試行と観測**：各通知を個別ack/retryします。不正/無関係な通知・不存在予約はignored、同意/BAN/停止等はdeferredとしてackし、状態を進めません。R2未保存・照合不一致・上流障害・不正応答は60秒遅延retry。定期照合でも1件の失敗で残件を止めず、次回候補に残します。ログはaccepted/ignored/deferred/retryの件数のみで、payload・ID・原本キー・秘密・生例外を出しません。RPCは固定Supabase URL、redirect禁止、5秒timeoutです。

### 実接続前の条件

WranglerのQueue consumer・Cron・flagは**未追加**です。コードmergeだけでは回復処理は起動しません。既存の`KOKO_UPLOADS_ENABLED`と新しい`KOKO_UPLOAD_RECOVERY_ENABLED`の両方が文字列`true`の場合だけ有効です。未設定のscheduledは無操作、Queueは成功returnによる暗黙ackを避けて固定エラーで失敗させます。無効化時はconsumer停止/切離しを調整し、retry上限による配送喪失を放置しません。

本人確認後の実接続では、既存Supabase設定・R2 bindingに加え、`KOKO_UPLOAD_RECOVERY_QUEUE`と実consumerのQueue名一致、既存`R2_ACCOUNT_ID`との一致、原本bucketの限定通知規則を確認します。batch最大10件、有限retryとDLQ、consumer concurrency上限、Cron `*/5 * * * *`を明示し、秘密やproducer権限・公開範囲を拡大しません。これらの外部設定、追加SQLの実適用・実配備・受付有効化は別の保護操作です。

DLQ監視/回収、スキャンの滞留・負荷検証、未完了uploadの失効/安全な中止、受付終了・BAN等で確定できない原本の運用回収は後続です。定期照合は全bucket列挙を行わずDB予約のみを対象とするため、予約のない孤児原本は拾いません。R2イベント実配送・多接続DB競合・DB→R2の実通し試験は未実施です。

[SQL試験](../../packages/contract/test/upload-completion.test.mjs)はAPI/回復の順序・同じoutboxへの合流・guard変化・権限・claim上限/繰下げを検証します。[Workers試験](test/upload-recovery.spec.ts)は通知hint・RPC/R2異常・HEAD限定・個別再試行・定期候補検証・既定無効入口を検証します。共通の[応答parser](src/completion-result.ts)と既存HTTP試験で、公開受領票へ内部情報を混入させません。

根拠（2026-10-05確認）：[R2通知schema](https://developers.cloudflare.com/r2/buckets/event-notifications/)、[Queuesのack/retry・DLQへの遷移](https://developers.cloudflare.com/queues/configuration/batching-retries/)。

## メディア処理予約のQueue配送（B1-6の後段、既定無効）

[配送Worker](src/media-dispatch.ts)と[追加migration](supabase/migrations/20261005050000_dispatch_media_outbox.sql)は、complete/回復が作った`process_media` outboxをCloudflare Queuesのproducerへ渡すローカル実装です。**Queue受付は変換・判定・公開の成功ではありません。** 下記consumerもローカル実装済みですが、実binding/Cron・Cloud Run認証は未構成のため有効化しません。

- **入口**：文字列`KOKO_MEDIA_DISPATCH_ENABLED=true`かつ専用cron `* * * * *`だけ。`MEDIA_PROCESSING_QUEUE` producer bindingと既存Supabase設定を検証してからDBへ接続します。indexで5分間隔のR2回復cronと振り分け、R2通知consumerをメディア処理用として共用しません。受付flagと独立して停止できます。
- **claim**：service-role限定`claim_media_dispatch(固定event,50)`。`KOKO_EVENT_ID`の対象event内で`READ COMMITTED`・`FOR UPDATE SKIP LOCKED`を使い、未完了/未配送・配送期限到来・leaseなし/期限切れの`process_media`だけを最大50件、配送可能時刻/作成時刻/ID順で取得します。120秒のleaseと単調増加する配送attemptを同transactionで記録し、別eventの行には触れません。
- **配送状態の分離**：`dispatch_attempt`、`dispatch_available_at`、`dispatch_locked_until`、`dispatched_at`を追加。従来の処理用`attempt`/`available_at`/`locked_until`/`completed_at`、投稿状態/version/counter/payloadには触れません。送信成功時でも処理完了にはしません。
- **最小message**：`version:1`、`kind:process_media`、`job_id`/`event_id`/`post_id`/`asset_id`/`post_version`のみ。UUIDは小文字正規形、versionは正の32bit整数。raw payload、原本キー/URL、object version/ETag、利用者ID、秘密は送信しません。再送でも同じID/versionを使用し、配送attemptはmessageに含めません。不正payloadはQueueへ渡さず有限再試行へ残します。
- **送信と確定**：返却jobのeventを全件照合し、別eventが混在すれば送信・settleとも行いません。1 batchをawaitし、正常受付後にだけservice専用`settle_media_dispatch(固定event,claims)`へ`sent`を渡します。対象eventの現在のattemptと有効なleaseが一致する場合だけ更新し、期限切れ/旧世代/完了済みは`stale`。一括入力は全件検証後、ID順にlockして更新します。
- **障害**：送信失敗/10秒timeoutは結果不明として`retry`。DB時刻から15/30/60/120/240/480/900秒の指数backoff、最大8 claimで停止し、行を削除・処理完了にしません。claim応答喪失や送信後DB失敗はlease満了後の再取得になり、重複配送があり得ます。8回目の失敗/lease満了は`exhausted=true`で検出します。これは件数でなく枯渇行の存在、既存8回目の送信中はまだ枯渇としません。
- **境界**：RPCは固定2本のPOST、redirect禁止、各5秒（本文読取り込み）・64KiB上限。Queue送信10秒を含め通常1 invocationは最大約20秒。生例外・ID・本文をログへ出さず、固定集計`claimed/sent/retry/invalid/settled/stale/exhausted/failed`だけ。`sent`はproducer受付件数、`settled`はsent/retry両方のDB更新件数であり、両者は一致するとは限りません。

下記consumerはDB正本のjob/post/asset・object version/ETagを読み直し、削除/BAN/公開停止・post versionを再照合します。Queueのat-least-onceと「送信→DB確定」の間の障害をexactly-onceと扱いません。配送済み後のconsumer失敗はQueue retry/DLQ側の責務です。

有効化前に実Queue/DLQ・滞留/枯渇監視と回収手順を受け入れ、実Queue作成・binding/Cron・migration適用・配備を本人の個別確認へ分離します。枯渇行のpayload/attemptを自動修正・リセットしません。dispatcher自体の枯渇は集計出力であり、後段の処理障害通知とは別です。2026-10-06に30投稿/分の目標を下回る旧10件/分制約を最大50件へ修正しました。再送余地を含む有限バッチで、無制限drainではありません。[Queues公式上限](https://developers.cloudflare.com/queues/platform/limits/)の1sendBatch 100件/256KB以内を守りますが、負荷・公開SLO達成は別途実測します。

[SQL試験](../../packages/contract/test/media-dispatch.test.mjs)と[Worker試験](test/media-dispatch.spec.ts)で権限・期限/世代・原子性・有限再送・不正/重複/遅延・最小投影を検査します。PGlite単一接続と模擬Queueの成功を、多接続PostgreSQL競合・実Queue配送・変換完了の証拠にはしません。根拠（2026-10-05確認）：[Queues producer API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)、[配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)、[PostgreSQL行lock](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)。

## 画像処理のDB確定（B2-1の一部、実環境未接続）

`20261006000000_image_processing.sql`は、[内部画像pipeline](../image/README.md#内部画像処理pipelineb2-1の一部既定off)へ渡す処理計画と、4閲覧派生物の保存結果を管理します。[Node側のDB client/内部runner](../image/README.md#db接続と内部runnerb2-1の一部既定off)と認証HTTP/consumerはローカル接続済みですが、実DB・実Cloud Runへは未適用です。公開API契約・既存RLSを変更せず、`service_role`だけが`manage_image_processing(event, post, job, action, input)`を呼べます。`SECURITY INVOKER`・空のsearch_pathで、ブラウザへ公開しません。

| action   | input                                | 成功時の範囲                                                                                                                                                      |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`  | `{}`                                 | 最新DBを検査し、120秒・最大3回の画像処理leaseを発行。初回だけuploaded→processing、post.version更新、4派生assetの固定キー予約。`CLAIMED`とpipeline形式のplanを返す |
| `check`  | `{plan}`                             | 完全一致する現在のplanとDB状態・期限を再検査。`CURRENT`だけが継続可。行をlockするがデータを書き換えない                                                           |
| `finish` | `{plan, originalSha256, deliveries}` | pipelineの4保存receiptをすべて検査後、寸法・byte数・hashと画像段階完了を同一transactionで記録。`RECORDED`を返す                                                   |
| `fail`   | `{plan, reason}`                     | 現在lease・固定理由を照合し、AIとは別の処理失敗証拠、原本保持のheld、job決着、通知予約を原子的に記録                                                              |

`READ COMMITTED`でevent→settings→member→consent→post→assets→jobの順にlockし、所有者・現行同意・BAN/latch・削除・受付/公開停止・投稿版・原本asset/ETag/version/bytesを照合します。画像用leaseはQueue配送leaseと別物です。既受付の写真は投稿受付終了後も処理できますが、eventがliveでない場合やprivate_at以降は拒否し、lease期限もprivate_atを超えません。所有者変更へ古いleaseを引き継ぎません。

有効lease中のclaimは`BUSY`、期限後の再取得は同じ4asset・同じ処理版と新しいleaseId、3回消費後は`EXHAUSTED`と非公開held記録です。古いlease、改変plan、状態不一致は`STALE`です。原本64MiB・派生物各16MiBは現在のbuffer処理用の資源上限であり、投稿仕様のサイズ上限ではありません。原本上限超過は`RESOURCE_LIMIT`としてheldと通知を記録し、不正入力/receiptは`INVALID_INPUT`で更新しません。どちらも自動削除せず、処理失敗をAI違反として加算しません。

finishのreceiptは内部pipelineが得た`eventId / assetId / variant / format / outcome / sha256 / size / width / height`のみを受理します。異なる4asset・形式/寸法・整数・hash等を全件検査してから更新し、DB例外では全更新をrollback。完了済みの同じreceiptは、配列順や`stored`/`already_stored`の違いを除いて冪等です。異なる証拠・保存済みmetadataとの矛盾は`CONFLICT`。現在の認可・状態の再照合は省略しません。完了済みclaimの`IMAGE_SAVED`は画像段階の記録済みを示すだけです。

**画像段階の完了は公開許可ではありません。** 正常finishは`outbox_jobs.completed_at`・配送状態・AI判定・投稿公開・カウンターを変更しません。DBは実R2のbytesを読まず、信頼済み内部処理の証拠を受けます。原本hashだけを追記し原本データは変更せず、AI用JPEGは保存しません。R2の4PUTとDB transactionは一体ではなく、部分保存や失効後のPUT完了が残り得ます。条件付き・非上書き保存と最終DB照合を維持し、失敗を公開へ進めません。

`packages/contract/test/image-processing.test.mjs`は全migrationをPGliteへ適用して権限、期限/再取得、所有者変更、停止/BAN、receipt不正、版の上限、末尾更新失敗の全rollbackを検証します。単一接続のSQL試験であり、実PostgreSQLの多接続競合、pipelineとの実通信、実R2/Cloud Run/Queue・AI/公開の受入は未完了です。

## 本人の投稿状態と一覧（B2-6の一部、既定無効）

[本人投稿ハンドラー](src/own-posts.ts)は既存の生成型を使い、`GET /posts/{post_id}/status`と`GET /me/posts`を実装します。アップロード完了時の固定受領票を再利用せず、毎回Google単独認証と`X-Event-ID`の所属を確認して現在の投稿状態を取得します。Bearerまたは上記の明示設定されたCookieに対応し、GETにCSRFは要求しません。Cookieの送信元制限は維持します。

- **本人限定**：[追加migration](supabase/migrations/20261005040000_read_own_posts.sql)の`read_own_posts`はservice_roleのみ実行可能なSTABLE・SECURITY INVOKER・空search_pathの読取り関数です。所属と投稿は同一statement snapshotで確認し、event/userを必ず両方絞ります。管理者にも他人の投稿は返しません。他人・別event・不存在のIDは同じ404、未所属は403です。既存の本人索引を使い、RLS・テーブル権限・データは変更しません。
- **投稿可否と分離**：BAN中・規約未同意/更新後・公開/受付停止・非公開イベントでも、所属本人は処理中・保留・BLOCK・削除済み等の状態を確認できます。これは公開フィードや原本を閲覧する権限ではなく、BANの解除や投稿の復活を行いません。
- **最小限の応答**：ID・event・状態・version・作成時刻と、必要時の固定エラーコードを返します。BLOCKは`CONTENT_BLOCKED`とallowlistで検査した7大分類だけ、保留/送信失敗は許可済み固定コードまたは汎用理由へ変換します。処理エラー自由文・OCR・原本キー・URL・所有者情報を透過しません。deletedには保持情報不明・保持待ち・物理削除機能未有効・削除未確認の状態とDBに記録された保持期限を投影し、運営一覧でも同じ安全投影を使います。DBの期限は実バケットLock確認済みの証明ではなく、消去済みの断定もしません。
- **キーセット**：一覧は`created_at DESC, id DESC`、limitは既定30・1〜100、最大limit+1件の読取り。Postgresのmicrosecond精度を丸めず、同時刻をUUIDで分けます。`next_cursor`は続きがなければnull。新着は再取得した先頭ページから表示し、カーソル行の削除でoffsetのようなずれを起こしません。複数ページを一つの固定snapshotとして保持する方式ではなく、各取得時点の状態を返します。
- **署名cursor**：[専用codec](src/own-post-cursor.ts)でHMAC-SHA256、用途・順序・event・本人・limit・位置・15分の期限を結び付けます。改ざん・期限切れ・別本人/event/limit/鍵・未知形式は`INVALID_CURSOR`でDB前に拒否し、最初から取り直します。署名は暗号化ではなく、cursorには本人/event IDと位置が含まれます。認証の代用やログへの記録、共有をしません。
- **通信と失敗**：全応答は`private, no-store`、共有cacheなし。AuthとRPCを合わせて10秒、各応答256 KiBのJSON上限、redirect禁止、クライアント中断時に取消し。型・順序・重複・scopeの異常は安全側に失敗し、上流本文・秘密headers・生例外を返しません。CORSは追加しません。

将来の有効化には`KOKO_OWN_POSTS_ENABLED`が文字列`true`であることが必要です。未設定/その他はAuth・DB前に404。一覧には独立した乱数32byteを64桁hexで表す専用`KOKO_POST_CURSOR_SECRET`も必要で、欠落/不正なら500です（単一状態取得には不要）。Supabase/Access/CSRFの秘密を再利用せず、サーバーだけに保存します。今回は実鍵の生成・登録、Wrangler設定・公開範囲の変更、DB適用・配備を行っていません。

[SQL試験](../../packages/contract/test/own-posts.test.mjs)と[Workers試験](test/own-posts.spec.ts)で全状態・本人/他人/別event/管理者・read-only transaction・microsecond/同時刻/途中削除・署名の独立既知ベクトル・改ざん/期限・不正応答・中断を検証します。[Web中継・本人投稿画面](../web/README.md#本人の投稿一覧状態画面f2-4f3-4の一部既定無効)も既定無効で接続済みです。公開フィード/詳細/10秒DTO cache・申立て/削除導線は下記のStage3実装へ進みましたが、実Supabase RPCとWebの通し受入や実機は未実施です。模擬試験だけでB2-6全体やF2-4の完成とは扱いません。

根拠（2026-10-05確認）：[PostgreSQLの行比較](https://www.postgresql.org/docs/current/functions-comparisons.html)、[STABLEとsnapshot](https://www.postgresql.org/docs/current/xfunc-volatility.html)、[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。

## 第3の運営操作と認証付き閲覧（ローカル実装、実接続未受入）

`stage-three-operations.ts`と`20261006030000_stage_three_operations.sql`は、`KOKO_STAGE_THREE_ENABLED=true`の明示設定時だけ、お題・通報・申立て・本人削除・運営操作を受け付けます。公開済み設定変更、Cloudflare等の保護変更、運用上の閾値承認を自動実行するものではありません。

- service限定RPC、空search_path、event→settings→member→postのロック順、Google認証・最新所属/役割・Cookie/CSRF。moderatorは監視/非表示/復帰/削除/原本取得、adminは追加でBAN/解除・お題/閾値/申立て対応。本人削除/申立てはBAN中も可能。
- 通報は本人重複を除き、1件で先に非表示、2件目で追加通知を予約。BAN解除だけでは投稿を復活させず、adminの明示復帰と現在の判定・保存証拠が必要。原本物理削除はこのRPCでは行わない。
- お題は同一event、有効期間と状態を検証。使用中のお題削除は終了扱い。閾値変更は承認を解除し、未校正の設定を勝手に承認しない。全公開停止は受付停止も同時適用。
- `public-feed.ts`/`20261006040000_media_read.sql`は既定OFFの共通一覧・単一投稿。全候補の現在版・可視性をDBで再確認してから10秒DTO cacheを使用し、認可はcacheしない。created_at/idの署名キーセット、一般DTOに原本キー/Stream UID/ユーザーIDなし。お題名は同eventの公開中/終了済みだけを返し、未選択・非公開はnull。名称変更もcache fingerprintへ反映。一般利用者はポーリング、管理者の更新ヒントだけ下記Realtimeへ分離。
- 派生画像bytesだけをisolate内部cacheへ保存可能（合計4MiB、1件1MiB、16件、固定30秒TTL）。未完了capture/使用中entryも容量管理し、全長とSHA-256一致後だけ保存。原本・Stream・Range missは保存しない。取得ごとの認証/DB照合と途中の再認可、外部応答の`private, no-store`は維持。永続性・isolate間共有・費用削減率は保証せず、集計hit/missと費用を実環境で測定する。
- `media-delivery.ts`は`KOKO_MEDIA_DELIVERY_ENABLED`で非公開派生物を中継。`KOKO_ADMIN_ORIGINALS_ENABLED`で`GET /admin/posts/{post_id}/original?expected_version=N`を運営役割に限定。BLOCK/deleted/削除予約・異event・版違いを拒否し、R2の版/etag/サイズ/派生hashを照合。原本はattachment、全応答no-store、任意URL・redirectなし、単一Rangeに対応。監査を記録するが物理取得の完了を保証するものではない。

`stream-delivery.ts`は署名必須動画だけを固定customer hostから取得します。別用途のtoken資格情報・AES-GCM子参照用secretが必要で、既存cursor/Access secretは流用しません。HLS子URLもevent/post/version/120秒期限へ結び付け、都度認可し、転送中も停止状態を再確認します。MP4は既成のものだけで、取得中の生成操作はしません。

**Stream技術例外**：[Cloudflareの自前player手順](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)はmanifestのproxyを推奨していません。KOKOではUIDや署名URLを一般に出さず、非公開化後の子リソースも遮断する要件を優先し、毎回fresh取得・no-store・限定書換えを採用しています。公式の一般経路と同じ互換保証とは扱わず、実Stream manifest/Range/期限/実機試験を必須とします。短命token APIの負荷上限も未計測であり、署名鍵方式への移行には別の本人確認が必要です。

AI判定のDB確定は`20261006020000_media_moderation.sql`へ分離。承認済み24カテゴリとprovider共通quota、frame/engine/attemptのdurable消費、原本と変換証拠、BAN/停止/設定版を再照合します。PASS/FLAG/BLOCK/HELD・累積BAN・公開counter・通知outboxを同一transactionで確定し、不明な保持期間を推測して原本削除しません。単体部品の成功をQueue完了に読み替えません。

Web側中継/運営画面は[Web README](../web/README.md)を参照。PGlite・Workers・Webの合成試験は実施しますが、実SQL適用、Secret/IAM、Stream/AI/Discord実呼出し、認証付き実機、校正/負荷、公開判断は未実施です。

## Stream準備と処理Queue（B2-2、実環境未受入）

`stream-processing.ts`・`stream-runner.ts`・`20261006050000_stream_processing.sql`で、固定原本HEAD→条件付き読取り署名→Stream copy/clip→非公開ready確認を接続します。受信入力は3 UUIDのみで、原本キー/UID/処理計画をDBから再取得します。

- copy/clipのoperation IDを外部呼出し前に永続予約し、応答喪失・クラッシュ時にcreateを重ねません。有限のpollとメタデータ照合で既存操作を回復し、未知の結果は保留。旧世代の再利用も同じ原本asset/etag/version・event/postの証拠が必須です。
- 全長fallbackは別UIDのclip、通常の短縮原本はsourceを使います。duration実測4秒以下、ready・処理完了・署名必須・許可origin・原本/親clipの一致なしでは判定へ渡しません。3.8/3.5/3.0秒の短縮候補も無制限に生成しません。
- `media-consumer.ts`は固定Queue名・eventと厳密な7項目hintを照合し、DBの現状態→必要なら動画準備→private Cloud Run `/internal/process`→DB再照合。HTTP200だけでACKせず、永続した完了/保留/世代交代の証拠が必要です。Queue名の衝突・未設定は暗黙ACKを避けて拒否します。
- サーバーの認証準備はブラウザログインと別です。`cloud-run-client.ts`は外部OIDC→固定Google STS→IAM Credentialsの短命ID token取得をローカル検証していますが、Workerで信頼するOIDC発行元/取得元は未確定です。`index.ts`は架空のassertionを注入しません。**現在の設定だけでCloud Runまで動く完成品とは扱わず、consumer有効化前のゲートです。**

| 設定群                                                                                                                               | 用途・実登録の境界                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `KOKO_STREAM_PROCESSING_ENABLED`                                                                                                     | 既定OFF。DB側の処理flag/実受入と併せて有効化                                 |
| `R2_ACCOUNT_ID`、`KOKO_STREAM_API_TOKEN`、`KOKO_STREAM_CUSTOMER_HOST`、`KOKO_STREAM_PLAYBACK_ORIGIN`                                 | 固定account・Stream管理・配信先。API tokenは秘密                             |
| `KOKO_STREAM_R2_READ_ACCESS_KEY_ID`、`KOKO_STREAM_R2_READ_SECRET_ACCESS_KEY`                                                         | 原本読取り専用。アップロード用鍵と分離し、実発行/入力は本人                  |
| `KOKO_MEDIA_CONSUMER_ENABLED`、`KOKO_MEDIA_PROCESSING_QUEUE`、`KOKO_EVENT_ID`                                                        | 既定OFFのconsumerと固定Queue/event。実Queue binding/consumer登録は未実施     |
| `KOKO_IMAGE_SERVICE_URL`、`KOKO_IMAGE_CALLER_EMAIL`、`KOKO_IMAGE_CALLER_SUBJECT`                                                     | private Cloud Run origin・許可サービス主体。利用者Googleログインを代用しない |
| `KOKO_GOOGLE_WIF_PROVIDER_AUDIENCE`、`KOKO_GOOGLE_WIF_SUBJECT_ISSUER`、`KOKO_GOOGLE_WIF_SUBJECT_AUDIENCE`、`KOKO_GOOGLE_WIF_SUBJECT` | WIFを選ぶ場合の固定照合値。信頼するassertion供給元が別途必要                 |

`wrangler.jsonc`へQueue/Cron/秘密の実設定は追加していません。1分Cronは既存media dispatchと運営outboxへ分岐し、5分Cronは原本回復に使用します。登録・有効化、最大配送回数/DLQ・Cloud Runのinstance/並列上限は実配備前に確定します。

`stream-webhook.ts`・`20261006090000_stream_webhook.sql`は`POST /internal/stream-webhook`のHMAC署名・本文64KiB・header8KiB・時刻窓とDB予約を検証し、DB由来の既存Queue hintだけ送ります。未知/他event/旧世代は状態を書き換えず、HTTP202は動画完成ではありません。copy応答より先に通知が来ても予約operation/原本の一致が必要で、consumerがproviderを再取得します。

Envの`KOKO_STREAM_WEBHOOK_ENABLED`とDBの`stream_webhook_enabled`は既定OFF。秘密`KOKO_STREAM_WEBHOOK_SECRET`は固定`R2_ACCOUNT_ID`と同じStreamアカウントで発行したものが必要（payload自身にaccount IDはありません）。Stream送信元は現在のAccess資格情報を付けられないため、**既存Worker全体のAccessを解除せず、専用受信口の限定設計・登録を本人確認するまで未有効化**です。有限pollによる検知と、webhook実接続の受入を区別します。

## 管理者だけのRealtime（B3-3、既定OFF）

`20261006070000_admin_realtime.sql`はprivate topic `koko:admin:<event UUID>`へ`{changed:true}`だけ送ります。投稿本文・ID・名前・原本・OCR・秘密や行全体を配信しません。Google/現行同意/非BAN/adminまたはmoderatorを照合し、KOKO namespaceを他の広い許可policyからも限定します。一般利用者の書込みは許可しません。

DBの`admin_realtime_enabled`とWebの`KOKO_ADMIN_REALTIME_ENABLED`は既定false。Supabaseの管理テーブルのRLSを勝手に変更せず、存在するがRLS無効ならmigrationを失敗させます。ローカルのRealtime schema不在は通知して既定OFFのまま通しますが、それをクラウドの接続成功にしません。

Realtimeの認可はjoin/JWT更新時にcacheされるため即時サーバー失効を保証しません。受信は再読取りのヒントだけで、画面は最新の認証APIから再取得し、操作時にも再認可します。権限変更・切断・期限・背景化の試験を実接続後に実施してください。

## 通知と削除待ちの運用outbox（B2-5/B3-5、既定OFF）

`stage-three-outbox.ts`・`20261006080000_operational_outbox.sql`で、DB lease→最新情報の投影→外部送信前の永続予約→結果記録を行います。既存outboxを使い、追加Queueは作りません。`KOKO_OPERATIONAL_OUTBOX_ENABLED=true`とDBの`operational_outbox_enabled=true`が必要です。

- Discordは別の`KOKO_DISCORD_NOTIFICATIONS_ENABLED`、秘密`KOKO_DISCORD_WEBHOOK_URL`と固定`KOKO_ADMIN_ORIGIN`が必要。固定Discord webhookだけ、mentionsなし、画像なし。表示名/投稿ID/固定カテゴリ/認証必須管理導線だけを送ります。個人データの通知先の閲覧権限・利用目的は人間の確認対象です。
- 1Cron最大10件・同時2件、HTTP10秒、DB lease5分、最大5試行/24時間。明確な429だけ有限backoff。タイムアウトや送信済みか不明な結果は`ambiguous`で止め、成功にも自動再送にも変えません。送信意図を記録後のクラッシュも同じです。
- `revoke_delivery`完了は最新DBのアプリ配信拒否確認であり、取得済みbytesや発行済みprovider tokenの回収を意味しません。
- `delete_assets`は原本の保持/lock情報を検査し、不明・保持中・物理削除adapter未有効を`held`で可視化します。`completed_at`を埋めず、物理削除済みと誤表示しません。原本消去、Bucket Lock/Lifecycle設定は未実施で、本人ゲートを維持します。

## R2容量監視（B3-6、既定OFF）

`capacity-monitor.ts`と`20261006100000_capacity_monitor.sql`は、固定開発2バケットのpayload＋metadata使用量をCloudflare GraphQLから読み取り、承認済みbyte閾値以上なら通知outboxを原子的に予約します。`KOKO_CAPACITY_MONITOR_ENABLED`、専用読取り秘密`KOKO_CAPACITY_ANALYTICS_TOKEN`、固定event/accountに加え、DBの`capacity_limit_bytes`・人間による`capacity_limit_approved`と運用outbox設定が必要です。新しいtoken・権限・閾値をこのコードから設定しません。

1時間の永続epochごと最大3試行、120秒lease、設定版/対象/時刻/件数を検査。時間別snapshotを加算せず、各バケットの最新値を使います。2時間を超える古い値、欠測、権限エラーは不明として扱い、0byteや正常通知済みにしません。閾値変更で承認を解除し、再承認まで停止します。これは容量観測と通知であり、料金・予算上限・自動停止の保証ではありません。実GraphQL権限/更新遅延/Discord到達は未受入です。根拠：[R2のmetrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)、[Analytics認証](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)（2026-10-06確認）。

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
