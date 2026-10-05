# 画像変換コア（B1-7／B2-1の一部）

Node.js 24で、入力bufferからAI用JPEGと閲覧用WebP/JPEGを生成します。`src/index.ts`が呼出し境界、`convert.ts`が変換、`worker.ts`が同期decoderの隔離、`cli.ts`がローカル受入用、`r2.ts`が既定OFFの内部ストレージadapter、`pipeline.ts`が既定OFFの取得・変換・保存の接続です。下記の認証HTTPと判定runnerをローカル接続しています。実API/Webからのクラウド通し受入は未実施です。

## 実装と未実装

- HEIC：`heic-decode`のlibheif WASMで単一画像をRGBAへdecodeし、sharpへ渡す。その他はsharpのdecoderを利用。
- 長辺1024 JPEG、600/1600 WebP・JPEGの計5種類。縦横比維持、拡大なし、向き補正、sRGB、透明部は白へ合成。JPEG quality 85、WebP quality 82。画質の実機受入は未完了。
- EXIF/ICC/XMP/IPTCを派生物へ保持しない。原本bufferを変更せず、原本の保存/削除や公開状態は操作しない。
- 戻り値は固定名・形式・寸法・SHA-256・bytes。固定名はローカルの用途名でありR2キーではない。後続の保存adapterが契約のキーへ対応付ける。
- 同一process内は1変換だけ。実行中は`BUSY`。1回ごとにWorkerを作成し、既定15秒で停止してから次の処理を許可。自動retryなし。
- 空入力/不正な期限は`INVALID_INPUT`、decode不可能・複数画像は`DECODE_FAILED`、期限は`TIMEOUT`、Worker起動/異常終了は`WORKER_FAILED`。失敗時に部分的な派生物を返さない。raw例外/metadata/依存ログは外へ出さない。

HEICの多画像やアニメーションを先頭だけに切り捨てず失敗させます。これはAIの違反判定ではありません。変換コア自体はDBを変更せず、下記runnerが最新leaseを再検査して原本保持・非公開保留・通知予約へ接続します。

sharp既定相当の268,402,689画素制限とdecoder/メモリ/期限の実行限界があります。投稿APIのサイズ・形式制限ではなく、全画像の変換成功を保証しません。Workerの256MiB V8 heap制限はnative/WASM領域を含む完全なメモリsandboxではありません。本番ではプロセス/コンテナーの制限とバックプレッシャが別途必要です。

15秒は停止要求を出す期限です。native処理の終了待ちを含む厳密な応答時間の上限ではなく、停止完了までは次の変換枠を開放しません。

変換コア・ローカルCLIに加え、下記の**既定OFFの認証HTTP入口・AI判定・DB確定**をローカル実装しました。実IAM/DB/R2、[Queue consumer](../api/README.md#stream準備と処理queueb2-2実環境未受入)との外部接続・判定/公開は未受入です。CLIコンテナーの既定入口は変更せず、HTTPは明示したDocker targetに分離します。実機HEIC、HDR/広色域/特殊な向き、巨大/破損画像の網羅、30投稿/分・公開中央値60秒も未受入です。特にWASMのRGBA出力に原本ICCを移さないため、実機の色再現を確認するまで本番有効化しません。

## 非公開R2ストレージadapter（B2-1の一部・既定OFF）

`src/r2.ts`の`createImageR2Store`は内部のprovider adapterです。`KOKO_IMAGE_R2_ENABLED`が小文字`true`に完全一致しない場合はnull。単体では実行時環境変数を読まず、CLIからも呼びません。有効化したHTTPサービスのみ下記のサーバー構成を通して接続します。現段階で設定・tokenを追加する必要はありません。

- 固定の開発用`koko-dev-originals`はGETのみ、`koko-dev-derived`はPUTと再送照合用GETのみ。任意URL/バケット/キーを入力にせず、固定R2 hostと`@koko/contract`の`originalKey`/`deliveryKey`から構成。LIST/DELETE/原本PUT・署名URL生成なし。
- 将来の設定は`R2_ACCOUNT_ID`と、原本読取り専用の`R2_ORIGINAL_READ_ACCESS_KEY_ID`/`R2_ORIGINAL_READ_SECRET_ACCESS_KEY`、派生物読書き専用の`R2_DERIVED_ACCESS_KEY_ID`/`R2_DERIVED_SECRET_ACCESS_KEY`。同じkey IDを両用途へ設定することを拒否。実際のbucket限定権限は外部での本人確認が別途必要で、設定名だけでは最小権限を保証しない。
- `getOriginal`へはDBで確認したevent/post/asset・byte size・ETag・既知ならSHA-256を渡す。If-Match GETで200/ETag/Content-Length/実body長を照合し、SHA-256を算出。既知hashがある場合は比較する。既知hashなしの初回算出を「元ファイルとのhash一致確認」と扱わない。multipart ETagは原本全体のMD5ではない。
- `putDelivery`へはDBで予約した**派生asset固有ID**、variant/formatと、信頼できる変換コアの生成物を渡す。4閲覧用だけ許可し、AI用1024は保存しない。寸法/名前/形式/hashを照合しbytesをsnapshot。画像自体のdecode・安全判定をこのadapterで代行しない。
- PUTはIf-None-Match `*`とContent-MD5、SHA-256 metadata、`private, no-store`付き。200とsingle-PUT ETag一致で保存応答。412だけ条件付きGETへ進み、実bytesのSHA-256・長さ・ETag・Content-Type・private/no-store・hash metadataが一致した場合だけ`already_stored`。別内容/metadataは`DELIVERY_CONFLICT`で上書きしない。MD5は転送整合性であって安全性判定ではない。
- 署名・通信・body読取り全体で既定15秒、redirect/自動retryなし。圧縮応答を拒否し、失敗/期限切れ/遅延応答のstreamは取消す。例外は固定理由だけで、provider body/秘密/URLをログ・例外へ付けない。
- buffer方式の資源上限は原本64MiB、派生物1件16MiB。超過時は通信前に`RESOURCE_LIMIT`。これは投稿APIの容量上限ではなく、原本を保持して処理保留/別方式へ接続するための実行限界。全同時処理の上限・バックプレッシャは将来のconsumerで別途実装する。

認証・最新DB job/lease/post version/所有者・BAN/削除/停止・原本identityの再照合は**呼出元の必須責務**です。adapterはDBを更新せず、公開を許可しません。4件の保存は原子的でなく、途中失敗の部分保存や期限切れ後のPUT完了があり得ます。全件の照合後にDBで最新処理版を原子的に確定し、AI/公開条件を別途確認する必要があります。曖昧な結果を成功扱いせず、原本/派生物を自動削除しません。

既存採用済みaws4fetch 1.0.20と共有契約だけを直接依存に追加しました。[R2 S3互換表](https://developers.cloudflare.com/r2/api/s3/api/)と[公式署名例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)を根拠に、模擬fetchで条件付き操作と署名を検証。実R2/IAM/Secret/クラウド料金・実機の受入は未実施です。

## 内部画像処理pipeline（B2-1の一部・既定OFF）

`src/pipeline.ts`の`createImagePipeline`は、既存のR2 adapterと変換コアを接続します。`enabled: true`、store、信頼できるサーバー実装の`isCurrent(plan)`を明示した場合だけ生成し、それ以外は無効または構成エラー。環境変数の自動読取り・HTTP/Queue登録・新しいSecretはありません。

- planにはDBで照合済みのjob、**画像処理用lease**、post version、期限、原本identity、予約済みの異なる4派生assetを渡す。既存Queueのdispatch leaseを画像処理leaseと流用しない。plan自体は認証情報でも認可の証拠でもなく、外部payloadを直渡ししない。
- `isCurrent`は最新DBの所有者・job/lease/version・原本/予約asset・停止/BAN/削除等を検査する必須の読取りcallback。原本取得前、変換前、各保存前、全保存後に呼ぶ。strict true以外・例外・既定5秒の期限・plan失効は後続を止める。期限後にcallbackが成功しても再開しない。[DBのclaim/check/finish](../api/README.md#画像処理のdb確定b2-1の一部実環境未接続)と結ぶ内部runnerは下記に追加済み。実DB適用・実クラウド受入は未完了。
- planと入力/生成bufferをsnapshotし、await中の呼出元変更から分離。1インスタンス1処理、実変換コアも同一process内1変換。サービス全体の同時実行数の保証ではない。
- 原本の長さ・SHA-256と変換中の不変を照合し、5生成物すべての名前・形式・寸法・hashを検査してから、4閲覧用だけを条件付き保存。AI用1024 JPEGはメモリ内の戻り値のみ。実AI送信はしない。
- 成功は`outcome: saved`と原本hash・AI用bytes・4保存receipt。**非公開保存の確認であり、投稿完了・判定通過・公開許可ではない。** 失敗は固定理由だけで、部分成功receipt、provider例外、秘密を返さない。
- 部分保存、最終確認失敗、処理中のDB変更はあり得る。自動retry・rollback削除をせず、呼出元が同じ予約assetの条件付き再送と最新DBでの原子的確定へ接続する。保存前の確認とPUTの間の状態変更も、後段のDB確定/公開ゲートで拒否する必要がある。

合成HEIC→実decoder→署名付き模擬R2→再送照合の通し試験、全7確認点での中断、部分保存失敗、期限・改変・不正出力を自動検証します。処理lease/asset予約・原子的DB記録のSQLは別途ローカル検証済みですが、実DB適用・実R2・HTTP/IAM・Queue consumer・AI/公開・実機受入は未完了です。依存するcallback/store/transformは内部実装であり、この部品だけで処理全体の厳密な時間/メモリ上限を保証しません。

## DB接続と内部runner（B2-1の一部・既定OFF）

`src/db.ts`の`createImageDatabase`と`src/runner.ts`の`createImageRunner`で、DB claim→pipelineの7地点check→4保存→DB finishを接続します。いずれも`enabled: true`の明示と正しい依存が必要です。単体は環境変数やHTTPに依存せず、下記サービス構成が呼び出します。CLIの実DB接続はありません。Queue consumerのコードはAPI側にありますが、実登録/外部接続は未実施です。

- **DB設定**：信頼するサーバー設定の`supabaseUrl`・`secretKey`だけを使う。HTTPSの20文字project ref＋`.supabase.co`のoriginに限定し、user info・port指定・path・query・fragmentを拒否。job/payloadから送信先や鍵を決めない。Secretは`apikey` headerだけで、Bearer/Cookie/ログ/戻り値へ複製しない。キー入力・登録は今回未実施。
- **RPC**：固定の`/rest/v1/rpc/manage_image_processing`へPOST。redirect・cache・自動retryなし。既定/最大5秒でfetchとbodyをまとめて制限し、応答16KiB、200＋JSON＋厳格UTF-8、既知のcode/shapeだけ受理。エラー本文は返さず`DB_FAILED`、期限は`DB_TIMEOUT`。遅れて到着したbodyも破棄する。
- **plan**：pipelineと同じsnapshot検査を共有し、job/event/postの一致、4asset・原本・処理版を照合。claim時に失効済み/異常に遠い期限を拒否（DBの120秒に時計差許容5秒）。JSONの形が正しいことだけを認可とせず、各段階でSQLの最新検査を呼ぶ。
- **receipt**：finish前に4件すべての所属・一意性・整数/寸法/容量・hashを検査してsnapshot。DBへ送るのはplan・原本hash・4件のmetadataだけ。画像bytes・AI縮小物・任意URLは受け付けない。期限後のfinish再送はSQL側の「同一内容で既に記録済み」照合へ委ねる。
- **runner**：1インスタンス1件。通常成功はclaim 1回＋check 7回＋finish 1回で、finishの`RECORDED`後だけ`image_recorded`とメモリ内AI用画像を返す。DB/変換/保存失敗・停止/旧leaseでは後続を止め、AI bytesや部分成功を返さない。これはプロセス全体・複数instanceの同時実行上限ではない。
- **重複/曖昧結果**：`IMAGE_SAVED`は`image_already_recorded`という別の結果で、画像I/Oとfinishを繰り返さず、AI bytesもない。claim/finish応答を失った場合はDB commit済みでも失敗として保留する。自動のlease解放/取消し・再送・削除はせず、次の明示runは最新DBへ照会する。

**どちらの画像段階の成功結果もQueue ACK、process_media全体の完了、AI判定や公開許可ではありません。** 記録済みの再配送やfinish応答喪失後はAI縮小物が戻らないため、下記の判定runnerが原本を再照合・decodeして回復します。入力jobは認証済み内部呼出元が渡す3 UUIDだけであり、このrunnerを認証なしのHTTPへ公開しないでください。

decode不可能・派生物不正・原本不一致・保存競合・資源上限は、現在leaseとDB認可が有効なら専用の`processing_failure_receipt`を記録して非公開`held`へ進めます。通知予約とjob決着は同一transactionで、AI判定・違反加算・BANは作りません。通信障害/クラッシュは期限付き再取得を最大3回に制限し、枯渇時も同様に保留します。DB自体の停止や未承認設定を成功/違反に読み替えません。運営者の明示再処理は新job・現在版を使い、同一原本と過去証拠の一致時だけ既存予約を再利用します。原本/途中保存物を自動消去しません。

DB client/runner試験は模擬RPCで通信契約・7地点の停止・曖昧なfinishを検証し、合成HEIC→実decoder→署名付き模擬R2→metadata確定→重複runまで通します。SQL/PGliteは別試験で、実PostgREST/実DBと画像処理を通した試験ではありません。同じ新規試験をDockerにも登録し、実IAM/DB適用/R2/Queue/実機/負荷は別の受入ゲートに残します。

一次資料（2026-10-06確認）：[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)、[PostgREST RPC](https://docs.postgrest.org/en/stable/references/api/functions.html)。新SDK・実行依存・公開API型は追加せず、Workersの実装をNodeへ持ち込みません。

## 認証HTTP入口（画像段階のみ・既定OFF）

`service-auth.ts`でGoogle ID tokenを検証し、`service.ts`の限定HTTP handlerから既存runnerを呼びます。Node transportは`server.ts`、環境変数読取りと待受起動だけは`service-main.ts`。採用理由・比較は[ADR-0007](../../docs/decisions/ADR-0007-private-image-service.md)に記録します。

- Cloud Run IAMで未認証呼出しを禁止する構成が前提。アプリ内でもRS256署名、Google issuer、設定済みservice originとのaud完全一致、許可service accountのemail/数値sub、email_verified、iat/exp・最大1時間を確認。通常のGoogle利用者ログインでは通らない。
- 検証鍵は固定Google JWKSからのみ取得。JWT内の任意鍵/URLを採用せず、64KiB・5秒・redirect禁止、5分の鍵cacheと30秒のunknown-kid cooldown。JWT/claims/鍵/例外本文をログや応答へ出さない。
- `Authorization: Bearer`だけを使用。Cookie/Origin/`X-Serverless-Authorization`併用を拒否し、forwarded identity headerを信用しない。Googleが後者の署名を除去する方式へ暗黙fallbackしない。実IAMとの通し試験は未実施。
- `POST /internal/image`は認証後に最大1KiBのJSONを5秒以内で読み、eventId/postId/jobIdの3 UUIDだけ受理。任意URL/plan/鍵/画像は入力不可。1handlerにつき同時1件、busyは429。Node transportでもheader上限・重複Authorization拒否・読取り期限を設定。
- `/internal/image`の成功応答はstage/outcome/`processComplete:false`だけ。画像bytes・原本キー・DB plan・provider本文を返さない。HTTP 200をQueue ACK、AI完了、公開許可に使わない。全処理は別の`/internal/process`と下記判定runnerへ接続し、consumerがDBで最終確認する。
- `GET /health`はready/disabledの固定状態だけ。Google/R2/DBへの疎通確認ではない。Cloud Run上ではこれもIAMの背後に置く。

サービスを有効化するには`KOKO_IMAGE_SERVICE_ENABLED=true`に加え、`KOKO_IMAGE_SERVICE_AUDIENCE`（実サービスのHTTPS run.app origin、path/末尾slashなし）、`KOKO_IMAGE_CALLER_EMAIL`、`KOKO_IMAGE_CALLER_SUBJECT`が必要です。さらに既存R2設定と`SUPABASE_URL`/`SUPABASE_SECRET_KEY`をサーバー専用に渡します。不足時は固定構成エラーで起動せず、秘密値を出力しません。既定OFFなら秘密/構成を解決せずhealth以外404です。

Dockerの`--target service`がHTTP専用入口です。importでlistenせず、起動時だけ`PORT`（既定8080）と0.0.0.0を使用。SIGTERMで新規接続を止め、8秒後に終了します。中断した処理は完了扱いにせず、DB leaseと再送照合へ委ねます。CLIのruntime/default targetは従来どおりです。

**今はクラウドへ設定・配備しないでください。** サービス作成、IAM invoker限定、token取得方式、Secret登録、予算/instance上限、実DB migration、実R2権限を本人確認後に準備します。共有の長期サービス鍵を安易に発行せず、短命ID tokenを使う構成を実接続前に確定します。ライブラリは`jose` 6.2.12を直接依存/lockfileで固定し、JWT検証の自作実装を避けています。

## AI判定adapter（B2-4、実接続未受入）

`src/moderation.ts`は、メタデータ除去済み`ai-1024.jpg`だけを受ける内部adapterです。写真は1枚、動画は実測4秒以下・異なる3時点が必要。SHA-256・JPEG寸法・metadata不在を再確認し、原本・任意URLを送りません。実AI呼出し、課金や鍵登録は今回行っていません。

- 既定OFF。承認済みの設定版・24カテゴリ全件の閾値、用途別token供給、共有quota予約callbackがそろわなければ起動しない。欠落値を仮の安全閾値で補完しない。
- OpenAIは`omni-moderation-2024-09-26`に固定。画像6カテゴリ、SafeSearch5カテゴリ、OCR文字判定13カテゴリ。画像非対応カテゴリの0を安全の根拠としない。OCRによって写真に写った人の年齢を判定できるとは扱わない。
- SafeSearchは`likelihood-ordinal-v1`（0 / 0.25 / 0.5 / 0.75 / 1）の順序尺度で、確率ではない。モデルや写像変更時は再校正が必要。Visionは`builtin/stable`指定で、実モデルの細かな版は非報告と記録する。
- 固定API URL、redirect禁止、最大15秒/試行、最大2retry。429・quota不足は待ち戻し。インスタンス内同時実行と共有quotaを区別し、各provider呼出し前にframe/engine/attempt/providerごとのdurable予約を要求する。DBから渡す`attemptStarts`でクラッシュ後も試行枠を補充しない。
- 正常なOCR文字なしを`no_text`と記録し、失敗/nullと区別する。判定は既存契約のBLOCK > HELD > FLAG > PASS。いずれかの必須判定失敗をPASSへ変えない。
- 返却はframe別スコア・モデル・時間・試行/呼出し単位のみ。画像/OCR原文/鍵/生エラーを返さず、価格不明の費用はnull。adapter成功だけで公開せず、DBで現設定/BAN/同意/状態を再検証して確定する。

合成試験は固定応答・境界・取消し・retry枯渇の検査です。実quota・資格情報、200枚による校正、実応答形式、p95、費用と誤判定は未受入。共有quotaと原子的DB確定は次の内部runnerへ、Queue consumerは[API実装](../api/README.md#stream準備と処理queueb2-2実環境未受入)へ接続しました。実サービス間認証・有効化は未完了です。

### 費用推計の記録

`moderation-cost.ts`はclaim時の任意の`event_settings.moderation_cost_rates`をsnapshotし、HTTP試行数×設定単価のUSD参考推計をrunごとに保存します。版・UTC確認日/有効期限・固定公式出典・整数microUSD単価を厳格検査し、DBでもusageから独立再計算します。再試行も記録し、設定を消去しても版を巻き戻しません。既定は未設定で、未知・期限外・使った単価が不明ならnull、既知の0と区別します。料金は自動投入せず、設定変更も閾値承認を兼ねません。

これは請求確定額ではありません。月間無料枠、割引、税、他用途との合算、Stream/R2/Cloud Run等の費用や支出上限は含みません。料金変更は次のclaimから採用し、処理中120秒leaseのsnapshotは保持します。[費用方針](../../docs/product/cost-policy.md)に従い、実料金採択と請求照合は別に行います。公式出典は[OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation)と[Cloud Vision料金](https://cloud.google.com/vision/pricing)です。

一次資料：[OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation)、[API schema](https://developers.openai.com/api/reference/resources/moderations/methods/create)、[Vision annotate](https://docs.cloud.google.com/vision/docs/reference/rest/v1/images/annotate)、[Vision response](https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse)、[Vision model選択](https://docs.cloud.google.com/vision/docs/reference/rest/v1/Feature)（2026-10-06確認）。閾値とSafeSearch正規化はKOKO側の設計で、公式サービスが安全性を保証するものではありません。

## 判定までの内部接続（B2-4、既定OFF）

`moderation-db.ts`の固定service RPCと`moderation-runner.ts`を`POST /internal/process`へ接続しました。画像段階の`/internal/image`は従来どおり`processComplete:false`です。新入口はDBが判定を原子的に記録した場合、または既に同jobを記録済みの場合だけ`processComplete:true`を返します。200自体をQueue ACKの代わりにしません。

- 最初は画像保存→DBへ保存証拠記録→原本を再decodeしてAI用だけ生成。記録済み画像のretryでは派生物を再PUTせず、原本hashと保存証拠を照合して再判定する。
- `KOKO_MEDIA_PROCESSING_ENABLED`、`KOKO_VISION_METADATA_ENABLED`、`OPENAI_API_KEY`を全て明示するまで無効。VisionはCloud Runに割り当てたservice accountの固定metadata endpointから短命access tokenを取得し、任意metadata URLを受け付けない。IAM権限付与・Secret入力は未実施。
- 動画は`KOKO_VIDEO_MODERATION_ENABLED`と別途Stream設定が必要。DBが保持する非公開UID・原本/親clip関係、実測4秒以下・完全ready状態を固定管理APIで再検証し、3時点のprivate JPEGを取得。decode/metadata除去してからAIへ送り、入力HTTPのURL/画像bytesは受け付けない。
- DB planは現在の所有者・BAN・同意・設定版・状態・期限へ結び付く。quotaと試行枠は永続予約し、HTTP再送やクラッシュで枠を補充しない。失敗・不明・必須判定欠落をPASSにしない。

`moderation-runner.test.mjs`はPGliteの全migration→認証済み合成HTTP→実decode→模擬provider→DB公開確定→再送の縦通しを含みます。DockerのverificationだけにPGlite等のdev依存とmigrationを入れ、runtimeはproduction依存だけに維持します。これは実PostgREST・実AI・実IAM・実R2を通す受入ではありません。

## ローカル検証

### 校正結果のオフライン集計（B3-7の準備）

`evaluation.ts` / `evaluation-cli.ts` は人間が正解ラベルを付けた匿名化済み結果だけを集計します。画像やAIへの通信、DB設定変更は行いません。build後に `Get-Content -Raw <非公開の結果JSON> | node apps/image/dist/evaluation-cli.js` で実行し、結果の保管先はPrivate資料にします。入力は `{"version":1,"policy_version":1,"samples":[{"sample_sha256":"原本の64桁SHA256","expected":"allow","observed":"PASS","processing_ms":100}]}`。ラベルはallow/block、結果はPASS/FLAG/BLOCK/HELD/ERROR、未測定時間はnullです。本文・氏名・メール・原本パスは渡しません。

正常系200枚を不適切サンプルと別に数え、同一hashの重複を拒否します。BLOCK率・FLAG率・保留/障害率、不適切サンプルの公開率、nearest-rankの中央値/p95を別々に示します。保留/エラーをPASSとして除外せず、分母0と未計測はnull。件数を満たしても権利・ラベル・サンプル独立性・誤検知目標・運営承認は確認できず、閾値の自動承認はしません。実quota/料金、30投稿/分の負荷と公開までのSLOは別測定です。

### 自動検査

KOKOルートで実行します。依存はroot lockfileに固定し、既存Webのsharp版は変更しません。

image workspaceのbuild/typecheckはpre hookで共有契約を先にbuildします。Dockerにも同じ共有契約package/distを含め、過去の生成物へ依存しません。aws4fetchのFetch API宣言に必要なDOM型は画像workspaceだけへ追加し、Node runtimeやブラウザ非依存の共有契約は変えません。

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
