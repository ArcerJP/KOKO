# KOKO フロントエンド

Next.js App Router・TypeScriptをVercelで実行する領域です。[初期トークン](src/styles/tokens.css)を用い、撮影・Googleログイン・永続送信・フィード・運営画面を条件付きで実装しています。コードの接続と、実API・クラウド・実機での受入は別です。Figmaデザインの確定とも区別します。

[起動方法・実機の確認手順](../../docs/product/stage-one-capture.md)、[クラウドの準備](../../docs/product/cloud-setup.md)、[自動検証](../../docs/ci.md)を参照してください。リポジトリルートで`npm.cmd ci`、`npm.cmd run dev`を実行すると起動します。

## 第3の運営画面と個別取得（実環境未受入）

`KOKO_STAGE_THREE_ENABLED`が既定OFFのまま、`/manage`・`/themes`・`/appeal`と本人削除/通報コンポーネントを実装しました。Googleセッション、固定event、操作前の最新`/me`、役割・版・理由と確認を要求し、曖昧な更新結果を自動再送しません。BAN中の申立てと本人削除は公開フィードへのアクセスから分離。ログアウト・別本人/世代・画面離脱・停止通知で進行中の処理と表示を破棄します。

原本リンクは権限を持つ運営者が明示操作する個別取得だけです。`media-proxy.ts`は固定APIへ世代照合済みCookieとサーバー内Access資格情報だけを送り、原本キー/署名GET URL/Stream UIDをブラウザへ渡しません。BLOCK/deleted等の最終拒否はAPI側で必ず実行します。

- `KOKO_MEDIA_DELIVERY_ENABLED`・`KOKO_ADMIN_ORIGINALS_ENABLED`も既定OFF。DB/APIの対応設定と受入が必要。
- 画像/動画/単一Rangeはstreamingし、原本は固定attachment名。上流のCookie/Location/任意metadataを透過せず、redirect・交差origin・不正generation・任意転送先を拒否する。
- 応答headersは10秒、転送無通信は30秒で中断。全応答no-store。ホスティング基盤の実行時間/転送制限を超える巨大原本の取得は未受入で、アプリが無制限転送を保証するものではない。
- 合成unitとChromiumで操作・権限表示・破棄・390/1280pxを確認。実Google/Cookie/Access/DB/原本、実機、担当者による最終運用確認は未実施。

管理者だけのRealtimeは`KOKO_ADMIN_REALTIME_ENABLED`と[DBの専用gate](../api/README.md#管理者だけのrealtimeb3-3既定off)が必要。最新本人/役割の前後照合、private channelの接続期限、10秒間隔の本人再確認、背景/終了時の解除を行います。payloadは再取得ヒントだけで、フォーム入力を勝手に書き換えず更新案内を出します。実Realtimeの認可cacheや再接続・役割取消しは別受入です。

## 公開投稿フィード・全画面（F2-2/F2-3、実環境未受入）

`/feed`、`feed-client/controller/proxy`、`feed-media`を接続しました。「公開投稿」もログイン・イベント所属・現行同意と配信可否の確認が必要で、未ログイン向け公開ではありません。`KOKO_PUBLIC_FEED_ENABLED`とメディア/既存セッション中継設定が必要です。

- 3列grid、キーセット追加読込み、10秒ポーリングの新着案内。新着でスクロールを奪わず、お題filter・撮影/本人/運営画面への導線を用意。
- gridは画面内だけ最大6動画・ミュート/playsinline/loop。全画面は縦snap・前後1件だけ先読み、明示タップ後の音、戻る/左swipe/履歴と位置復元。画面外・背景・認証破棄時に再生/取得を止める。
- 全画面のお題名はAPIが同イベントの公開中/終了済みと確認した文字列のみ表示。非公開は名称を漏らさず、未選択は自由投稿と区別する。HTMLを解釈しない。
- native HLS対応時はそれを用い、その他は固定`hls.js`1.7.3を遅延ロード。任意URLを受け付けず同一originの認証経路だけ。既成MP4 fallbackを使用し、再生失敗でサーバー動画生成を起動しない。
- MSW/React/Chromiumの合成データで動作を検証。実Stream HLS/HEVC、iPhone/Androidの音・中断・復帰・4秒・10秒以内失効は別受入。端末へ取得済みのbytes回収は保証しない。

## お題選択・ヘルプ・正式本文の境界

送信画面はStage3 flag有効時だけ、最新のお題を明示読取りして任意選択できます。固定event・公開中・有効期間を照合し、期限切れ/再読込み/本人変更後は再選択を求めます。選択したお題を無断で自由投稿へ切り替えず、最終受付条件はAPIが検証します。本人一覧からは明示確認後の削除と申立てへ進み、削除ack後は最新状態を再取得します。論理削除を物理削除済みとは表示しません。

`/help`は音・端末キュー・OS中断・ログイン必須・削除/保管の違いと飯島優人/公開連絡先を案内します。`/terms`と`/privacy`は採択済みcatalogだけを表示します。**現在catalogは空・privacy未受領のため「準備中」のままです。下書きを正式本文として採用せず、同意受付も有効にしていません。**

## 初期トークン（K-07、初版承認済み）

- 明るい背景、白いsurface、インディゴの主色。危険・注意・成功は色に加えて文字/状態表示で区別。
- 日本語を含むsystem font、本文1rem、行間1.6。見出しは1.5rem/2rem。
- 余白は0.25rem単位、カード角丸1rem、操作領域は最小2.75rem。
- キーボードfocusを表示し、`prefers-reduced-motion`でfeedback時間を0へ。

正確な値はCSSだけを正本とし、変更はCSSと試験へ反映します。主要な文字色は4.5:1以上の計算テスト対象ですが、画面全体のアクセシビリティや実機可読性の完了を意味しません。

第6要件以降のiOS/Androidは[対応準備](../../docs/architecture/native-readiness.md)に従います。現段階でCSSを二重管理せず、native方式選定時に中立トークンと生成先を決めます。

## 実装時の入口

API型は`@koko/contract/api`、純粋な契約は`@koko/contract`から使用します。手書き型を複製しません。`src/api`の本人情報取得・更新境界をMSWの合成HTTP応答でNodeテストします。ブラウザ本番でMSWや偽セッションを有効化する設定はありません。本人1件の実Googleログイン・ログアウトと、別途実施したBearer API/DB試験の受入範囲は[クラウド準備](../../docs/product/cloud-setup.md)を参照してください。このWebクライアントの実Cookie接続とは区別します。

撮影UIは`src/components`、トリムは`src/media`、単体・HTTP/メディア統合は`test`、実ブラウザ操作は`e2e`です。動的メディア処理はWorkerへ分離し、必要時だけ読み込みます。

## 表示名・規約同意のHTTPクライアント

[client.ts](src/api/client.ts)は生成型の`getMe`、`updateMe`、`acceptTerms`を提供します。2026-10-04に更新2操作を追加しました。本人情報取得・表示名変更・規約同意は下記の画面へ条件付きで連携し、正式本文の採択と実環境接続は後続です。Workerの[Cookie受信・CSRF/Origin検証](../api/README.md#cookie認証とcsrf既定無効のローカル実装)、発行処理・本人情報中継と画面連携は既定無効のローカル実装です。クライアント側検査を認証・認可として扱いません。

- `updateMe({ display_name }, csrfToken, signal?)`は表示名だけ、`acceptTerms({ terms_version, accepted: true }, csrfToken, signal?)`は利用者が確認・同意した版だけを送信。空白のみ・長すぎる表示名・制御文字・偽同意・余分な項目と、Workerの1KiB上限を超えるUTF-8 JSONを送信前に拒否します。表示名や規約版を勝手に整形しません。
- CSRF値は`GET /me`の応答から呼出し側が各更新へ明示的に渡します。32〜256文字のheader安全な可視ASCIIだけを受け付け、欠落/不正なら送信せず`FORBIDDEN`。クライアントは生成・永続保存・自動補完しません。呼出し側もURL、ログ、localStorage、IndexedDB、共有cacheへ保存せず、ログアウト時にはメモリ上の状態を破棄してください。
- 固定の`me`/`consents`パスへJSONとイベントID・CSRF headerを送り、`mode`と`credentials`はともに`same-origin`、`redirect: error`、`cache: no-store`を使用。ブラウザの現在originと異なる設定は通信前に拒否します。手作業のCookie/Authorization headerやクロスorigin fallbackはありません。
- HTTP 200かつ検査済みの`Acknowledgement`だけを成功として返します。生成型だけを信頼せず、request/resource UUIDを実行時検査。本人情報とackの余分な応答項目は除外し、エラーはHTTP statusと契約codeが一致する固定メッセージへ限定します。
- 更新を自動再送しません。古い規約で`CONSENT_REQUIRED`となった場合は再取得・再表示し、利用者の新しい明示同意が必要です。取消しや通信失敗でもサーバーで保存済みの場合があるため、失敗を「保存されていない」と断定せず、再GETで状態を確認します。取得済みの本人情報をackだけで勝手に書き換えません。

[HTTP往復試験](test/account-mutations.test.ts)は、取得→表示名変更→再取得→同意→再取得、規約改訂、token欠落、不正入力/応答、認証エラー、redirect拒否、取消し、応答喪失後の状態確認を合成データで検証します。Node/MSWは実Googleセッション・ブラウザのorigin enforcement・サーバーCSRF・実DB受入を証明しません。配備済みWorkerはBearer限定のままで、このクライアントから直接Cookie書込みを有効化できません。既存SSRログインのCookieを新しいAPI用Cookieと同一視しません。

根拠：[Fetch標準のrequest mode](https://fetch.spec.whatwg.org/#concept-request-mode)、[OWASPのCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。API契約は[OpenAPI](../../packages/contract/openapi.yaml)、Workerと追加migrationの実装/未適用境界は[API README](../api/README.md#現行規約の同意保存ローカル実装)を正本とします。

## 初回イベント参加（B1-4/F1-4、既定無効）

`/account`の[参加フォーム](src/app/account/enrollment-form.tsx)から、Google本人が表示名を明示して参加できます。既存アカウント画面/Cookie/中継flagに加え、サーバー専用`KOKO_ENROLLMENT_ENABLED=true`が必要です。実設定は変更していません。通常の`/me`の所属必須条件を緩めず、[専用API](../api/README.md#初回イベント参加b1-4既定無効)を使います。

- [中継](src/api/enrollment-proxy.ts)は`GET/POST /api/me/enrollment`だけ、`X-Event-ID`はサーバーの固定`KOKO_EVENT_ID`と一致必須。既存のCookie世代・Origin・CSRF・Access秘密の固定上流転送・本文/時間制限を再利用。未設定は404で、秘密や任意の上流URLをブラウザへ返しません。
- [controller](src/api/enrollment-controller.ts)は「参加状況を確認する」から開始。未所属かつ受付中だけ名前入力を表示し、明示登録前にセッション準備とfresh GETで本人/event/受付を再確認。POST後もGETで所属を確認してから本人情報・規約画面へ進みます。別タブで先に参加済みなら再登録しません。
- ID/CSRFを表示snapshot・URL・永続領域へ保存しません。同時1操作、30秒、ログアウト/アカウント更新/pagehide/unmountで取消し・状態破棄。結果不明時は自動再送せず状況の再読取りを案内します。
- 登録は規約同意ではありません。正式本文未採択時は既存同意画面が閉じ、未同意投稿のAPI拒否を維持します。既存memberの表示名/role/BAN/同意を参加APIで上書きしません。

単体/HTTP試験とChromiumの390/1280px操作を実装。ブラウザ試験は実React＋合成Auth/APIで、製品へ認証回避routeを追加しません。実Google・Cookie/Access・実DB・実機・多接続競合は別受入です。

## 本人の投稿一覧・状態画面（F2-4/F3-4の一部、既定無効）

2026-10-05、`/account/posts`へ[本人投稿画面](src/app/account/posts/page.tsx)を追加しました。アカウント/送信画面から移動でき、[型付きclient](src/api/client.ts)の`listOwnPosts`/`getPostStatus`と[本人専用API](../api/README.md#本人の投稿状態と一覧b2-6の一部既定無効)を接続します。実環境は未有効化です。

- **入口**：[設定検査](src/api/own-posts-config.ts)でサーバー専用`KOKO_OWN_POSTS_UI_ENABLED`・`KOKO_OWN_POSTS_PROXY_ENABLED`と既存のアカウント画面/Cookie/API中継flagがすべて小文字の`true`、event IDがUUIDである場合だけ有効。Google単独の検証済みclaimsから期待本人を固定します。SSRで投稿/理由/cursorを取得せず、秘密をClientへ渡しません。未設定時は案内だけです。
- **中継**：[専用descriptor](src/api/own-posts-proxy.ts)から既存の固定先JSON中継を使い、`GET /api/me/posts`と`GET /api/posts/{post_id}/status`だけを許可します。中継flagが未設定なら全methodで404、設定時もGET以外は405。一覧queryは重複なしの`limit`（1〜100、既定30）/`cursor`だけ、単一状態queryは不可。既存の本人情報/更新経路は引き続きqueryを拒否します。Cookie世代・Origin・Accessのサーバー専用header・上流10秒/256KiB・redirect拒否・応答秘密検出・`private, no-store`を維持し、CORSを追加しません。
- **表示**：処理中・保留・BLOCK等の全契約状態、投稿ID・日本時間の作成日時・固定理由と安全な7大分類です。[応答投影](src/api/own-posts-contract.ts)で未知分類・判定自由文・URL・所有者情報を除外/拒否します。deletedの保持情報不明・保持待ち・物理削除未有効・削除未確認とDB記録の保持期限も表示し、実Lockや消去完了の確認済みとは扱いません。型/日付/並び順/重複/別eventを検査し、Postgresのmicrosecondを保ってページ境界を比較します。cursor署名/期限の最終検証と本人認可はWorkerの責務です。
- **操作**：[controller](src/api/own-posts-controller.ts)は初期自動取得なし。「本人確認・先頭から読み込む」、30件ずつの「続きを読み込む」、表示済み投稿の単一更新だけです。各操作はCookie発行/更新→本人/event確認→投稿取得→本人/event再確認の順で最大30秒、同時1操作・自動再送/ポーリングなし。BAN・未同意でも本人の状態確認は妨げません。操作時の追加通信と手動更新は必要ですが、背景通信/古いセッションの自動使用を抑えます。
- **保持と破棄**：最大300件まで画面メモリのみ、履歴/cursorをstorageや共有cacheへ保存しません。各操作中と失敗時は旧表示を消去。期限切れ/不正cursorは先頭再読込みを案内します。単一更新以外の行は前回取得時点であると表示し、一覧を固定snapshotとは扱いません。Auth通知、非表示、unmountで中断・破棄、別本人へのログイン/ログアウト・`pagehide`・既存のタブ間終了通知で画面を閉じ、遅延応答を拒否します。通知遅延/未配信・他端末の即時失効・取得済み画面の回収までは保証しません。
- **本人操作と取得の区別**：写真/動画、原本/AI判定自由文はこの一覧へ表示しません。Stage3 flag有効時だけ本人削除と異議申立ての導線を追加し、削除後はackで表示を決めず最新状態を再取得します。論理削除と原本の物理消去を区別します。公開投稿の閲覧は別の認証付きfeed、原本の個別取得は別の運営権限経路です。

[client試験](test/own-posts-client.test.ts)・[中継試験](test/own-posts-proxy.test.ts)・[controller試験](test/own-posts-controller.test.ts)・[入口/表示試験](test/own-posts-page.test.ts)で境界と失敗を検証します。[Chromium試験](e2e/own-posts.spec.ts)はローカル限定bundleと合成Auth/HTTPを使い、実Reactの読込み/ページ送り/単一更新、期限切れ、別tabの終了通知、Auth変化/非表示/離脱と390/1280px表示を検査します。productionにはharnessや偽認証routeを追加しません。実Next経路の既定OFFも確認しますが、実Google→Cookie→Access→DBの通し受入や実機受入の代替ではありません。

有効化は既存Cookie/Access受入、追加DBの実適用、Workerの本人読取りflag/専用cursor鍵とWeb設定の整合確認後です。秘密登録・設定変更・DB適用・実配備は[本人の保護操作](../../AGENTS.md#保護操作の確認)に分離し、この実装では行いません。第2・第3やF2-4/F3-4全体の完了とは扱いません。

根拠（2026-10-05確認）：[Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)、[Reactの購読とsnapshot](https://react.dev/reference/react/useSyncExternalStore)、[MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)。

## API用Cookieの発行処理（既定無効）

2026-10-04にWeb内部の`/auth/api-session`を追加しました。[Route Handler](src/app/auth/api-session/route.ts)から[発行処理](src/auth/api-session.ts)を呼びます。イベントAPIとは別のWeb専用経路であり、OpenAPIの本人情報契約を変更しません。**callback・中継・ログアウト・表示名/規約同意画面の操作時発行/更新は条件付きでローカル実装済みです。設定値の登録・実環境での有効化は未実施です。**

### 設定と送信元の条件

- サーバー専用の`KOKO_API_COOKIE_ENABLED`が小文字の`true`、`KOKO_WEB_ORIGIN`がpath・末尾slash・query・fragment・userinfoを含まない正規のHTTPS originのときだけ有効。公開用`NEXT_PUBLIC_`変数へ置かず、Worker受信側のoriginと一致させます。未設定・不正設定ではPOST/DELETEとも503 `API_SESSION_UNAVAILABLE`、Cookieを変更せずAuthにも接続しません。
- リクエストURLのoriginと`Origin`が設定値へ完全一致し、`X-KOKO-Session-Request: 1`が必要。`Sec-Fetch-Site`があれば`same-origin`だけを許可し、なければOriginと独自headerは引き続き必須です。Host・Forwarded・Refererから補完しません。
- 本文は0byteだけを許可し、query・Authorization headerは受け付けず、利用者が渡したJWT・本人ID・redirect先を採用しません。Next.jsの空POST/DELETEにも存在するストリームを、本文の存在と混同せず終端まで確認します。最初のchunk・読取り失敗・1秒以内に終端しない場合は拒否し、本文全体を蓄積しません。POST/DELETE以外は405 `Allow: POST, DELETE`。CORSは許可しません。送信元・入力の拒否ではCookieを変更しません。
- 独自headerは秘密やWorkerのCSRF tokenではありません。Cookieを初めて発行するときのCSRF対策として、固定OriginとCORS非許可を組み合わせます。Worker書込みのHMAC検証やOAuthのstate/PKCEを代替しません。

### 発行・更新・消去

1. POSTは下記の有効なログイン世代を要求し、既存SSR Cookieから`getSession()`でaccess JWTの候補を取得します。保存由来の`session.user`や`expires_at`は認可・寿命の証拠にしません。候補はJWTの3区切り形式、最大3,500文字です。世代を含めてもブラウザのCookie容量に余裕を持たせるため、Worker受信上限より厳しく制限します。
2. **同じJWT**を`getUser(token)`でAuthサーバーと照合し、`getClaims(token)`で署名検証します。Google単独・非匿名・authenticatedを両方で確認し、検証済み本人UUIDとsubの一致、整数のexpが未来であることを検査します。独自JWT検証やブラウザの本人情報へ依存しません。
3. 検証済み`sub`・`session_id`と世代の結び付きを検査し、成功時だけ`__Host-koko_session`へ`v1.<世代>.<access JWT>`を設定。JWT自体は改変しません。`Secure; HttpOnly; Path=/; SameSite=Lax`、Domain属性なし、Max-Ageは検証済みJWTの残り寿命と300秒の短い方、Expiresも同じ期限です。refresh tokenをAPI用Cookieへ入れません。再POSTは同じCookieだけを更新し、世代は上書きしません。
4. DELETEは同じ送信元検査後にAPI用CookieだけをMax-Age=0で期限切れにし、Auth接続・Supabase signOutは行いません。再実行可能ですが、セッションの失効やアプリ全体のログアウト完了を意味しません。

応答は成功200の`{ ok: true }`または固定の`{ code }`だけで、常に`private, no-store`です。認証不成立401、Google条件違反403、想定外例外500。POSTでAuth処理へ進んだ後の失敗は古いAPI用Cookieも消去します。JWT・refresh token・個人情報・生のAuth例外をJSON・URL・ログへ返しません。SSRの更新CookieはSDK既存方式のままであり、この変更で既存SSR Cookie全体をHttpOnly化したとは扱いません。

[サーバーAuthアダプター](src/auth/server.ts)はこのrouteと、API Cookieを有効にしたcallbackでCookie書込み失敗を固定エラーとして伝播する厳密モードを使います。既存の読取り専用Server Componentの動作は維持します。複数Cookieの保存・応答送達を原子的に保証するものではありません。

### 有効化前に残る作業

本人情報・表示名・規約同意の画面は操作時に発行/更新し、CSRFを操作中だけ保持する方式です。正式本文の採択とサーバー現行版との照合、下記の同一origin中継とAccess保護の実環境での両立、実Googleセッションとブラウザでのrefresh・終了競合・失効を検証してから有効化します。背景タイマーでの期限前更新は導入していません。条件付き実装だけで受入完了とはせず、設定だけ先に有効化してはいけません。

将来停止する場合は、設定を外す前のCookie消去経路と、停止後の既発行Cookie/JWTの扱いを決めます。flagをOFFにするだけでは残存Cookieを消去せず、DELETEも無効になります。Cookieの300秒制限をJWTの即時失効や漏洩対策の代わりにしません。設定・認証・公開範囲・実配備は[保護操作の個別確認](../../AGENTS.md#保護操作の確認)へ分離します。

[発行処理試験](test/api-session.test.ts)はNextResponseの実Cookieシリアライズと合成Auth応答を使用し、未設定、送信元・別資格情報の拒否、本人/署名結果/期限の異常、更新・消去・秘密非出力を検証します。[アダプター試験](test/auth-server.test.ts)はCookie writerの失敗伝播、[Playwright試験](e2e/login.spec.ts)は設定なしの実Next.js HTTP経路の503・Cookie非変更を検査します。成功時のブラウザCookie保存、暗号署名そのもの、SDKの実refresh、実クラウド接続を証明するものではありません。

根拠（2026-10-04確認）：[Next.jsのCookie書込み境界](https://nextjs.org/docs/app/api-reference/functions/cookies)、[Supabase getSessionの注意事項](https://supabase.com/docs/reference/javascript/auth-getsession)、[getUserの本人照合](https://supabase.com/docs/reference/javascript/auth-getuser)、[getClaimsの署名検証](https://supabase.com/docs/reference/javascript/auth-getclaims)、[OWASPの独自headerによるCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)。

## 本人情報・表示名画面（既定無効）

2026-10-04、既存の認証済み`/account`へ[AccountPanel](src/app/account/account-panel.tsx)と[表示名フォーム](src/app/account/profile-form.tsx)を追加しました。[controller](src/api/account-profile.ts)はUIから独立し、生成型を使う既存clientを利用します。既存のGoogle検証を省略したテスト用公開routeやブラウザ本番の偽セッションは追加しません。

### 有効化条件と操作

- サーバー専用`KOKO_ACCOUNT_UI_ENABLED`・`KOKO_API_COOKIE_ENABLED`・`KOKO_API_PROXY_ENABLED`がすべて小文字の`true`、`KOKO_EVENT_ID`がUUIDの場合だけ表示。未設定・不正なら従来のログイン確認/ログアウトだけです。検査は[account-config.ts](src/api/account-config.ts)で行い、サーバーからは公開可能なevent IDと採択本文（未採択ならnull）だけをClientへ渡します。API route側の正規Web origin・固定上流origin条件も別途必須です。
- 初期表示やEffectから本人情報APIを自動送信しません。「本人情報を読み込む」でAPI Cookie発行/更新→`GET /api/me`、保存時にも発行/更新→fresh GET→PATCH→確認GETの順です。背景タイマーを置かないため待機中の不要なAPI要求を抑えますが、操作ごとの通信は増えます。発行POSTはログアウトと共用の[session-post.ts](src/auth/session-post.ts)で10秒・128byte、同一origin・redirect拒否・no-storeを維持します。
- 入力はclientと共通の検査で空白のみ・50文字超過・制御文字を拒否。未読込み・未変更・BAN・処理中・終了済みでは保存できません。入力の勝手なtrim/整形や、規約同意の代行はしません。
- 保存直前の本人ID・event ID・表示名を先行表示と比較し、変化があればPATCHせず再読込みへ。最新GETのCSRFだけを当該PATCHへ渡し、UI state・DOM・URL・ログ・storageへ保存しません。ACKだけでは成功表示せず、確認GETで同一本人・指定した表示名・非BANを確認します。
- 1画面1操作に限定し、二重送信・自動再送なし。Cookie準備から確認GETまで30秒で打切り、取消しを伝播。保存途中の通信/認証/再GET失敗は結果不明として古い表示と入力を消し、手動再読込みを案内します。入力途中の名前を保持したまま自動再保存しません。

### 状態の破棄と保証の境界

Auth通知の`INITIAL_SESSION`以外で状態を破棄し、`SIGNED_OUT`は画面を終了状態にします。通知callback内でAuth APIへ再入せず、session/JWTを受取・保持しません。ログアウトボタンは最初にcontrollerを終了し、API/Auth終了が失敗してもプロフィール編集を再開しません。ページ離脱の`pagehide`でも終了し、BFCacheから戻った場合はページの開き直しを案内します。購読解除とunmountで進行中要求を中止し、世代が変わった後の古い応答は表示・次のPATCH/GETへ使用しません。

本人情報と入力は画面のメモリだけ、CSRFは操作の局所変数だけです。保存前の照合はDBの原子的な楽観ロックではなく、GETとPATCHの間に他操作が保存した場合の競合まで防ぎません。既送信要求の取り消し、Auth通知の遅延・未配信、他端末終了の即時検出も保証しません。最終認可はWorkerに残します。世代Cookieの境界は[ADR-0004](../../docs/decisions/ADR-0004-web-session-generation.md)どおりです。

[controller/HTTP試験](test/account-profile.test.ts)は合成応答で通常往復・fresh CSRF・本人取り違え・部分失敗・二重押下・取消し/遅延・停止を検査。[入口試験](test/account-page.test.ts)と[フォーム試験](test/profile-form.test.ts)はSSR表示と非公開値の非出力、[Chromium表示試験](e2e/profile-view.spec.ts)は純粋フォームのHTML/CSSで390/1280pxのラベル・focus・横はみ出しを検査します。後者はReactをhydrateしたクリック往復試験ではありません。有効時の実OAuth→Cookie保存→Access→DB→表示名更新と、端末/複数タブの通し受入は未実施です。正式本文の採択・実同意受付・メディア機能も別工程です。

根拠（2026-10-04確認）：[Reactの不変snapshotと購読解除](https://react.dev/reference/react/useSyncExternalStore)、[Supabase Auth通知](https://supabase.com/docs/reference/javascript/auth-onauthstatechange)、[Next.js Server/Client境界](https://nextjs.org/docs/app/getting-started/server-and-client-components)。

## 現行規約の明示同意画面（本文未採択・既定無効）

2026-10-04、同じAccountPanelへ[同意フォーム](src/app/account/consent-form.tsx)を追加しました。**正式本文は未採択で、[採択本文の一覧](src/api/approved-terms.ts)は空です。設定を有効にするだけでは同意できません。** テスト専用の文章を正式規約として配布せず、Googleログインや画面表示を規約への同意と扱いません。

### 本文と版の管理

- 一覧はイベントごとに1つの現行文書を持ち、イベントUUID・共通の版・利用規約の段落・プライバシーポリシーの段落を必須とします。サーバーで選択し、未設定・重複・不正ならnull。外部URL取得、HTML/Markdown解釈はせず、Reactの文字列として全文表示します。
- [本文検査](src/api/terms-document.ts)は版を1〜128文字・制御文字なし、各本文を1〜128の空白だけでない段落、文書JSONをUTF-8で128KiB以内へ限定します。本文/版を勝手に整形せず、コピーを凍結して後の呼出し元変更を切り離します。APIが返すevent ID・現行版と完全一致する文書だけを同意対象にします。
- 本文の追加は運営による内容・版・公開の確認後に別PRで行います。本文変更時は版も変更し、旧版はGit履歴に残します。DBの現行版変更は別の保護操作です。片側だけの更新は同意不可に閉じ、同じ版の本文差替えで回避しません。これは技術的な版照合であり、法的妥当性や読了の証明ではありません。

### 明示操作と保存確認

チェックは初期状態でOFFであり、読込み・チェックだけでは送信しません。本人情報読込み済み・本文一致・同意が必要・チェック済みのときだけ送信できます。本人情報/表示名と同じcontrollerで1操作に限定し、次の順序で進めます。

1. API Cookieを発行/更新し、fresh GETで同一本人・同一イベント・確認済みの版と最新CSRFを照合します。版や本人が変わればPOSTしません。同じ現行版へ既に同意済みならPOSTせず、その状態を反映します。
2. `POST /api/consents`へ確認済みの版と`accepted: true`だけを送信します。CSRFはその操作の局所変数だけです。
3. 確認GETで同一本人・同一イベント・同一版・同意不要を確認してから成功表示します。BAN中の同意は既存API仕様どおり可能ですが、投稿制限解除と扱わず、表示名保存のBAN制限も維持します。

失敗・中断・30秒超過は結果不明として状態とチェックを消し、再送せず手動の本人情報再読込みへ案内します。Auth変更・pagehide・ログアウト・unmountにも既存の取消し/世代検査を適用します。Server Componentから渡る本文/版が変わった場合は、イベントと本文JSONのSHA-256をReact keyとして画面を作り直し、旧チェック/処理を引き継ぎません。このhashは再生成の識別子であり、署名や同意証跡ではありません。チェック・本人情報・CSRFを永続保存しません。

[状態/HTTP試験](test/account-consent.test.ts)は合成応答で明示操作・fresh CSRF・確認GET、版/本人変更、BAN、部分失敗、時間切れと終了後の遅延応答を検証します。[表示試験](test/consent-form.test.ts)は未チェック・同意済み・未設定・エスケープを、[Chromium試験](e2e/consent-view.spec.ts)は静的renderした実フォームとCSSを390/1280pxで検証します。後者はReactのhydration・実Auth・Cookie保存・実DBへの同意登録の通し受入ではありません。正式本文の採択と実接続は後続です。

根拠：[Reactの制御されたcheckbox](https://react.dev/reference/react-dom/components/input)、[keyによる状態のreset](https://react.dev/learn/preserving-and-resetting-state)（2026-10-04確認）。API/DBの認可・transactionをUIの検査で代替しません。

## API用Cookieを含むログアウト（既定無効）

[ログアウト処理](src/auth/sign-out.ts)を既存ボタンへ接続しました。サーバーから渡すのは`KOKO_API_COOKIE_ENABLED`の真偽だけです。無効時は従来のブラウザSupabase `signOut()`、有効時は固定の`POST /auth/api-sign-out`→Supabase `signOut()`の順で両方を試します。既存のglobal scopeを維持します。両方が成功した場合だけ`/login`へ完全遷移し、一部失敗は固定メッセージで再試行を案内します。同一ボタンの二重実行を抑止し、自動再送はしません。

API終了要求は同一origin・独自header・本文なし、redirect拒否・no-storeです。応答本文を含む10秒・128byte以内のJSON `{ ok: true }`だけを成功とします。この時間制限はAPI終了段階のもので、Supabase SDKの通信全体を10秒に制限するものではありません。JWT・CSRF・Cookie値をJavaScript引数として扱いません。

終了routeは発行routeと同じ設定・送信元・空本文の検査を共用し、POST以外は405です。検査成功時にAPI Cookieを消し、下記の世代を`ended`へ置換します。Supabase/DBへ接続せず、Cookie欠落時も再実行可能です。**DELETE `/auth/api-session`はCookieの保守用消去であり、世代を終了しないためログアウトの代用にはできません。**

### 遅延応答への世代検査

[Cookie helper](src/auth/api-session-cookies.ts)が次のWeb内部プロトコルを管理します。採用理由と代替案は[ADR-0004](../../docs/decisions/ADR-0004-web-session-generation.md)を参照してください。

- API Cookie有効時の成功Google callbackだけが、新しい`__Host-koko_generation`を発行し、旧API Cookieを消去。世代はランダムUUIDと、検証済み`sub:session_id`（小文字UUID）のSHA-256を連結した値です。本人/セッションIDそのものはCookieへ入れませんが、hashを匿名化や認証署名とは扱いません。
- 世代CookieもSecure・HttpOnly・Path=/・SameSite=Lax・Domainなし。最大1年の識別子であり、認証・JWT・API Cookieの寿命は延長しません。欠落・期限切れ・`ended`・重複・chunk・不正形式なら発行と中継を拒否します。
- 発行要求の世代をAPI Cookieへ束縛し、中継は現在の世代との完全一致を要求します。発行routeは世代を更新しないため、終了や再ログイン後に届いた古い発行応答は中継できません。古いSSR更新Cookieが戻った場合も、発行時に検証したAuthの本人/セッションが新世代と異なれば拒否します。
- 中継は一致確認後に包みを外し、Workerには従来どおりraw JWTのAPI Cookieだけを渡します。世代Cookie・包み・SSR Cookieを転送しません。旧raw JWTだけのWeb Cookieへの互換fallbackはありません。有効化時は関連処理を揃え、改めてログインが必要です。

これは通常ブラウザの応答順序対策であり、JWTの即時失効、盗まれたCookieの再送、XSS、既にWorkerへ渡した処理の取消しを保証しません。別端末のCookieは削除できず、同時に進行中のOAuth callbackは新たなログインを成立させ得ます。Supabaseのglobal signOutも既発行JWTを即時失効させません。実ブラウザの複数タブ・refresh競合の受入は後続です。本人情報/表示名/規約同意画面は終了時に状態とチェックを破棄し、古い取得結果を再表示・再送しません。

[競合試験](test/api-sign-out.test.ts)は合成Authと実NextResponseのCookieを用い、終了/再ログイン→旧発行応答適用→中継拒否、別本人/同一本人の旧Authセッションから新世代への発行拒否を検査します。[順序・失敗試験](test/sign-out.test.ts)はAPI失敗時もAuth終了を試すこと、部分失敗、時間/容量上限を検査します。実Next E2Eは無効時の503・Cookie非変更とmethod拒否だけであり、有効な実ブラウザ/SDK/クラウドの完了を証明しません。

根拠（2026-10-04確認）：[Supabase signOutのscopeとJWTの残存](https://supabase.com/docs/reference/javascript/auth-signout)、[検証対象のJWT claim](https://supabase.com/docs/guides/auth/jwt-fields)、[Next.jsのCookie書込み境界](https://nextjs.org/docs/app/api-reference/functions/cookies)。

## 本人情報の同一origin中継（既定無効）

[account-proxy.ts](src/api/account-proxy.ts)をNext.jsのNode Route Handlerから使用します。`GET/PATCH /api/me`と`POST /api/consents`の3操作だけを、既存開発Workerの対応する`/me`・`/consents`へ転送します。汎用proxy、任意送信先、メディア/Range中継ではありません。2026-10-04のローカル追加であり、本人情報・表示名・規約同意画面は条件付き接続済み、正式本文と実設定は未接続です。

### 有効化条件と転送範囲

- サーバー専用`KOKO_API_PROXY_ENABLED`と`KOKO_API_COOKIE_ENABLED`がともに小文字の`true`、`KOKO_WEB_ORIGIN`が正規HTTPS origin、`KOKO_API_UPSTREAM_ORIGIN`が`https://koko-api-dev.arcer-jp.workers.dev`へ完全一致する場合だけ通信します。`NEXT_PUBLIC_`へ置きません。未設定・不完全・不正設定は契約の500 `INTERNAL_ERROR`となり、外部通信・Cookie変更はありません。別のWorkerやproductionを追加する場合は許可先・試験をコードレビューします。
- 要求URLのorigin/pathを固定し、query等は拒否。書込みは完全一致の`Origin`必須、GETも指定があれば照合します。`Sec-Fetch-Site`は指定時に`same-origin`のみ（GETは`none`も可）。欠落しても書込みOriginとCSRFは省略しません。CORS非許可、未対応methodは405、Host/Forwardedから補完しません。
- イベントUUID、単一の`__Host-koko_session`と一致する世代を要求（包み内JWTは発行側と同じ3,500文字上限）。Cookie全体16KiB超過・重複・chunk・Authorization併送は拒否します。Supabase SSR/Cloudflare Access/世代/その他のCookie、アクセス用秘密header、任意headerを透過せず、転送はraw JWTのAPI用Cookie・固定Origin・同一origin metadata・イベントID・JSON用headerと書込みCSRFに限定します。
- 書込みJSONは実ストリームで1KiB・UTF-8・1秒以内を検査し、content encodingは受け付けません。既存clientの実行時検査で表示名/同意/CSRFを検査・投影します。JWTの署名・Google条件・イベント所属・CSRFのHMAC・DB認可はWorkerが再検査し、Webの形式検査で代替しません。

### 応答・失敗時の扱い

上流取得と本文読取りを合わせて10秒、JSON本文16KiBを上限とします。要求中止も伝播し、リダイレクトを追跡せず、AccessログインHTMLや不正応答は固定エラーで閉じます。`Content-Length`だけを信用せず、分割chunkを合算します。自動再送・cacheはなく、更新後の通信切断を「未保存」と断定しません。

成功は既存clientで検査・投影した本人情報/ackだけで、Cookie経路の本人情報にはCSRF値が必須です。エラーは契約code/status/request UUIDを照合します。上流のSet-Cookie/Location/CORS/cache header・例外詳細を返さず、全応答を`private, no-store`とします。API Cookieの更新・消去は発行処理の責務であり、中継の401で暗黙に更新しません。429の任意`retry_after_seconds`など、既存clientが保持しない補助情報は透過しません。

### Accessサービス認証

2026-10-04、固定開発Workerへの本人情報3操作に、サーバー専用の`KOKO_API_ACCESS_CLIENT_ID`・`KOKO_API_ACCESS_CLIENT_SECRET`から`CF-Access-Client-Id`・`CF-Access-Client-Secret`を付与する処理を追加しました。2026-10-05に安全境界を[json-proxy.ts](src/api/json-proxy.ts)へ集約し、下記のアップロード制御4操作も共用します。上記の有効化条件に加え、**両方の資格情報が必須**です。各値は空白/制御文字/非ASCIIを含まない1〜512文字の可視ASCIIとして検査し、欠落・片方のみ・不正なら通信前に500で閉じます。新旧token形式の認証や期限・policyの判定はCloudflareが担当します。

値はNode Route Handlerで要求ごとに読み、`server-only`でClient Componentへのimportを禁止します。`.env.example`は空欄のままです。`NEXT_PUBLIC_`、クライアントprops、URL、ログ、応答、Gitへ値を渡しません。既存の転送header許可リストへこのサーバー由来2項目だけを追加し、ブラウザからの同名headerや`CF_Authorization`は引き続き使用しません。資格情報の存在で利用者Cookie・Origin・CSRF・Worker認可を省略しません。

リダイレクトを追わず、Access拒否/ログインHTMLも固定エラーで閉じ、認証方式のfallbackや自動再送は行いません。上流のheaderは透過せず、JSONをdecodeしたkey/valueに資格情報の完全値が含まれた場合も拒否します。これは既知の値の反射対策であり、分割・変換等を含むあらゆる漏洩を検出する保証ではありません。上流やプラットフォームのログにも認証headerを記録させない運用が必要です。

実tokenの本人発行と対象Access applicationへの個別許可を確認しました。**Web側のSecret登録・有効化・実配備・通し受入は未完了です。** 日時・適用範囲・検証結果の正本は[クラウド準備](../../docs/product/cloud-setup.md#webからのaccessサービス認証2026-10-04)、採用理由と権限境界は[ADR-0005](../../docs/decisions/ADR-0005-web-access-service-auth.md)です。service tokenはWebサーバーが開発用外周保護を通るための資格情報であり、利用者のGoogle JWTやDB権限、Worker配備用tokenとは別です。

#### 実接続前の本人ゲート

1. 対象Access application・固定Worker・既存All traffic/本人限定policyを読取り確認。変更案はこのapplicationへの個別service tokenを許可する`Service Auth`に限定。`Bypass`、`Everyone`、`Any Access Service Token`、組織全体strict設定の変更で代替しません。
2. token名・期限・許可するWeb環境を本人が決定し、対象を明示して作成/権限変更を個別確認。`koko-api-dev-deploy`やSupabaseキーを流用しません。値は本人がSecret保管先へ直接入力し、チャットへ貼りません。
3. 承認されたWebサーバー環境にだけ2項目を登録。Preview全体へ無条件配布せず、環境変更に伴う配備も別に確認。全flagは準備完了までOFFを維持します。
4. Worker Cookie/CSRF設定・追加migration・正式イベント/所属・規約採択を含む実受入計画と対象SHAを照合。実配備・DB書込み・有効化は個別確認し、自動配備OFFを維持します。
5. 本人Googleセッションで正常系、未認証/無効service token、JWT欠落、Origin/CSRF違反、所属なし・旧規約・BAN、終了/更新競合を確認。失効日、更新責任者、停止/失効手順を記録。合成試験を実接続成功と扱いません。

[中継試験](test/account-proxy.test.ts)は合成Cookie/資格情報/上流応答で3操作・利用者の秘密header非転送・不完全設定・環境値の都度読取り・反射拒否（JSON escape含む）・不正入力/応答・時間/容量上限・取消し・更新非再送を検証します。VitestだけNext同梱の空markerへ解決し、productionの`server-only`境界は変更しません。[実Next E2E](e2e/login.spec.ts)は既定無効の500とOPTIONS拒否です。有効時のブラウザCookie保存、実Access/Supabase/DB接続やアプリ全体の認証ゲートの完成を証明しません。

根拠（2026-10-04確認）：[Next.js BFFの境界](https://nextjs.org/docs/app/guides/backend-for-frontend)、[OWASP SSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)、[Cloudflare Accessのサーバー間資格情報](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。

## アップロード制御とR2直接転送（F1-5、既定無効）

2026-10-05、[upload-client.ts](src/api/upload-client.ts)、[upload-proxy.ts](src/api/upload-proxy.ts)、[upload-transfer.ts](src/media/upload-transfer.ts)をローカル追加しました。**撮影検証画面からは呼び出しません。送信UIと永続キューは下記の独立した既定無効の画面へ接続し、実クラウド受入は未完了です。** BEの[受付](../api/README.md)と生成OpenAPI型を利用し、ブラウザでの形式検査を認証や保存済みの証拠にしません。

### 固定JSON経路

| Web側のPOST経路                    | クライアント操作 | 本文上限               | 成功                                 |
| ---------------------------------- | ---------------- | ---------------------- | ------------------------------------ |
| `/api/uploads`                     | `open`           | 4KiB                   | 200 UploadTicket                     |
| `/api/uploads/{upload_id}/refresh` | `refresh`        | 0byte                  | 200 同じuploadのTicket               |
| `/api/uploads/{upload_id}/parts`   | `parts`          | 4KiB・一度に1〜100part | 200 指定partだけの署名               |
| `/api/posts/{post_id}/complete`    | `complete`       | 1MiB・最大10,000part   | 202 同じevent/postのuploaded receipt |

- 既存のAPI proxy/Cookie/固定origin/Access条件に加え、サーバー専用`KOKO_UPLOAD_PROXY_ENABLED=true`と、非秘密の`KOKO_R2_ACCOUNT_ID`（小文字32桁hex）が必要。未設定のupload flagは404で閉じ、通信しません。有効時はPOSTのみ、他methodは405。設定例はOFF/空欄、実環境へは登録していません。
- 同じ世代のCookie、Origin、CSRF、header許可リスト、secret反射拒否を既存本人情報経路と共用。Blobを中継せず、入力ストリームは1秒・上表容量、上流通信と本文は合わせて10秒。上流応答はpartsのみ1MiB、他は16KiB。署名URLを含む成功応答も`private, no-store`で、上流headerは透過しません。
- `createUploadClient(baseUrl, { eventId, r2AccountId })`のAPI通信はsame-origin・Cookie・redirect拒否。CSRFを操作ごとに明示入力し、受付のclient_request_idを勝手に生成し直しません。署名/CSRFの永続保存・ログ出力・自動再送なし。ID、metadata、parts、署名先、応答statusを実行時検査し、余分な項目を除外します。
- complete成功はR2保存の検証と処理予約の受付です。変換/AI/公開の成功ではありません。202のevent/post/versionを照合し、任意エラー詳細やR2生応答は利用者へ返しません。

### Blobの転送境界

`transferOriginal(blob, request, ticket, destination, options)`は保存申告用manifestを返します。呼出し側が別途`complete`し、必要に応じてAPI Cookieの更新とfresh CSRF取得を行います。R2にCookie・CSRF・Access資格情報・Refererは送りません。PUTのみ、CORS、credentials omit、redirect error、no-storeです。

- 送信先は指定accountのR2 S3 HTTPS endpoint、`koko-dev-originals`、同じevent/postの正規原本キーに限定。署名queryの形式・重複・期限（最大900秒）・signed headersを検査します。これは宛先制限であり、署名の真正性はR2が検証します。署名URLは短命でも権限を持つため、メモリ内だけで使用してください。
- singleは申告サイズとBlobサイズ、Content-Typeの一致を確認し、`If-None-Match: *`を維持。412も自動上書き/再送せず`STATE_CONFLICT`で止め、呼出し側で同じuploadの完了照合を判断します。
- multipartはBlob.sliceで逐次PUT。一つのpartを送る直前に`signParts`で署名を取得するため、遅い回線で後方partの期限を消費しません。各URLのpost/key/provider uploadの一貫性を確認し、R2の200と公開ETag（32桁MD5、引用符可）だけを記録。`onPart`は検査済みpartのコピーを通知します。署名URL自体はcheckpointへ保存しません。
- 1 PUTは120秒でabort。中断・期限切れ・ETag欠落・通信不明時に後続PUT/completeへ進みません。応答喪失でも保存済みの可能性があるため、新規投稿IDでのやり直しやblind retryをこの層で実施しません。ページ終了後の継続・バックグラウンド再開は未保証です。

### 有効化前のゲートと検証

送信UIの明示操作・本人同意・永続キューと、Worker upload/Cookie/CSRF設定・追加migration・署名鍵・R2 CORSを確認してから個別承認で有効化します。CORSは採用Web origin・PUT・必要headerだけ、ETagを公開する限定設定が必要です。設定変更や実データ送信は本PRに含めません。R2署名鍵をWebや`NEXT_PUBLIC_`へ置いてはいけません。将来UIへ渡すaccount IDは送信先識別子だけで、署名資格情報ではありません。

[クライアント試験](test/upload-client.test.ts)、[中継試験](test/upload-proxy.test.ts)、[転送試験](test/upload-transfer.test.ts)は合成受付→single/multipart→完了、容量・宛先・秘密・期限・取消し・ETag・失敗非再送を検証。[Next E2E](e2e/login.spec.ts)は4経路の既定無効を確認します。実ブラウザのR2 CORS・実Google/Access/DB・実R2保存・実機メモリは別の受入です。

公式確認（2026-10-05）：[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[R2 CORSとETag公開](https://developers.cloudflare.com/r2/buckets/cors/)、[Next Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)。

## Googleログインの検証導線

投稿画面は次節を参照してください。`/`の端末内検証と、明示送信を行う`/upload`は別です。

`/login`からSupabase AuthのGoogle OAuthを開始し、`/auth/callback`でcodeをCookieセッションへ交換します。`/account`は署名検証済みのGoogle単独セッションだけを表示し、ログアウトできます。認証ページは動的応答・非キャッシュです。既存の`/`は外部送信しない撮影検証画面のままであり、利用者向けアプリ全体の認証ゲートではありません。

接続時は[例](.env.example)に従い、SupabaseのProject URLと`sb_publishable_`で始まる公開用キーを設定します。Google Client Secret、Supabase secret/service_roleキー、セッションをここやGitへ保存しません。Supabaseには固定Web URLの`/auth/callback`だけをRedirect URLとして登録済みです。ローカルURLは未登録のため、ローカル実ログイン試験にはその完全URLの追加許可が別途必要です。現在のVercel保護とSupabaseのSite URLは維持しています。

SupabaseのEmail providerは無効化済みです。表示名/規約同意画面は既定無効で実装済みですが、正式本文の採択、Cookie/CSRFを使うAPI実接続、実機のセッション維持・失効試験は後続です。ログイン導線やHTTPクライアント・画面の追加をF1-4全体の完了とは扱いません。

メディアは[認証ゲート](../../docs/decisions/ADR-0002-authenticated-delivery.md)経由。Cookieを通さない公開画像最適化cacheや、署名付きStream URLの直接配布で代替しません。詳細な順序は[FEタスク](../../docs/product/development-plan.md#feタスク)を参照してください。

## 端末内送信キューと投稿画面（F1-5/F2-1、既定無効）

2026-10-05、`/upload`に明示送信画面を追加しました。撮影前/カメラ直下/処理後の注意、9:16の余白付きプレビュー、任意の選び直し、動画の3.8/3.5/3.0秒トリムを扱います。動画は端末実測とブラウザ読取が4秒以下の場合にトリム結果を採用、トリムfallback時は全長原本をR2へ送る旨を表示します。Streamへブラウザから二重送信せず、公開判定はサーバー側です。テーマ選択はF3の後続です。

### 保存・本人・再開の境界

- 新しいサーバー専用`KOKO_UPLOAD_UI_ENABLED=true`に加え、account/API Cookie/proxy/upload proxyの全flag、event UUID、非秘密R2 account ID、同じeventの採択済み規約本文が必要。現在の本文一覧は空、設定例は全OFFです。`/upload`の有効時は検証済みGoogle本人のみ、画面の明示読込でもfresh `/me`の本人/event/同意/BAN/版/CSRFを検査します。propsに渡すのはevent/account ID・版だけで、秘密は渡しません。
- [保存層](src/media/upload-queue-storage.ts)は`koko-upload-queue` v1の`entries`（metadata）と`blobs`（原本）を一つのIndexedDB transactionで追加し、`complete`後だけ受付表示。`strict` durabilityを要求しますが、物理的な永続性・保持を保証するものではありません。3秒を超えた場合は保存中と表示し、15秒timeout/容量不足/拒否では成功と表示せず送信しません。同じ選択素材の再操作は固定IDを維持します。
- 本人/eventをindexで分離し、保存読出しも全項目の形式を検査。ファイル名、JWT、Cookie、CSRF、署名URL、例外詳細は保存しません。Blobは暗号化していないため、共用端末・同originスクリプト/XSSから秘密を守る保管庫ではありません。保存前に画面で説明します。
- [queue engine](src/media/upload-queue.ts)をroot layoutの[provider](src/components/upload-provider.tsx)に保持。画面コンポーネントのunmountだけでは送信を止めません。初期表示・reloadで勝手に再送せず、同じ本人の明示再開を要求します。別本人には旧キューを表示せず、別eventへ移しません。
- Web Locksの同origin排他を初回本人確認・送信・手動再開・端末内削除に適用し、Cookie更新と別tabの制御要求を重ねません。未対応は安全停止、別tab実行中は待機案内。ログアウト開始は同tab eventとBroadcastChannelで通知し、SDKのAuth変更・pagehideでもabort/状態・プレビューを破棄します。既送信要求や発行済み署名を取消せる保証ではありません。停止後は改めて本人確認します。

### 再試行と完了

各JSON操作でCookie準備とfresh本人/CSRF検査を行い、合わせて15秒上限。R2 PUTの上限は転送層の120秒です。認可エラーは全体停止、その他の再試行不可codeも自動再送しません。再試行可能な失敗は初回＋最大3回（通常1/2/4秒、rate limitは補助秒数非透過のため60/120/240秒）。回数と次回時刻を保存し、失敗回数は自動でリセットしません。「この送信を再開」は同じIDに対する新しい最大3回の周期です。

- singleの未知結果は同じuploadのcompleteを照合。`UPLOAD_INCOMPLETE`のときだけ同じsessionをrefreshし、`If-None-Match: *`付きPUTへ進みます。別ID・上書きへ切り替えません。
- multipartは検査済みETag/part番号とkey/provider IDのSHA-256をcheckpointとして保存。再開は後続partから、署名は使用直前に更新。既存partを保持したまま別key/providerへ切り替える応答は拒否します。
- 完了manifestを送信前に保存し、以後は同じcompleteだけを再送。202のpost/eventを照合した後に`done`記録とBlob削除を同じtransactionで行います。画面は「サーバー受付済み（公開待ち）」であり、AI/変換/公開完了ではありません。
- 未送信分/受付記録の「端末の保存分を削除」は確認ダイアログ付き。これは端末内だけの削除であり、サーバー投稿の削除・R2 multipart破棄ではありません。ログアウト後も未送信原本は残ります。ログイン不能・BAN等で画面から削除できない場合は、ブラウザの当該サイトデータ削除が必要ですが、他のサイト保存情報も消えることに注意します。

### 検証と残る受入

単体試験は保存失敗、遅い保存、本人変更、上限retry、single曖昧結果、multipart checkpoint、complete replayを合成データで検証。Playwrightはtest runner内だけでbundleした合成画面で、実IndexedDBの保存/reload/本人分離/複数tab排他/quota例外rollback/画面切替と390/1280pxを検証します。製品の認証を迂回するrouteや試験用flagは作りません。動画Worker本体の実処理は従来capture E2E、新投稿画面のブラウザ試験は写真を対象とします。

実Google/Access/同意、実R2/CORS、iPhone/Androidの保存速度（3秒目標）・実動画送信/復帰・容量/eviction・OS終了中挙動は未受入です。ブラウザ終了中の常時送信は保証せず、元ファイルを保持してください。新flagを実環境へ登録・有効化する操作も、実配備・追加DB適用とともに本人ゲートです。

採用理由・比較・公式根拠は[ADR-0006](../../docs/decisions/ADR-0006-durable-browser-upload-queue.md)を参照してください。
