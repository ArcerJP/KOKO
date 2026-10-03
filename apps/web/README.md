# KOKO フロントエンド

Next.js App Router・TypeScriptをVercelで実行する領域です。[初期トークン](src/styles/tokens.css)を使う、端末内の撮影・トリム検証画面とGoogleログインの検証導線を実装しています。アップロード・AI判定は未接続です。Figmaデザインの確定とも区別します。

[起動方法・実機の確認手順](../../docs/product/stage-one-capture.md)、[クラウドの準備](../../docs/product/cloud-setup.md)、[自動検証](../../docs/ci.md)を参照してください。リポジトリルートで`npm.cmd ci`、`npm.cmd run dev`を実行すると起動します。

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

[client.ts](src/api/client.ts)は生成型の`getMe`、`updateMe`、`acceptTerms`を提供します。2026-10-04に更新2操作を追加しました。現段階では画面・実Cookieサーバーに接続しておらず、合成HTTP試験の完了です。Workerの[Cookie受信・CSRF/Origin検証](../api/README.md#cookie認証とcsrf既定無効のローカル実装)と下記の発行処理は既定無効のローカル実装であり、画面・同一origin転送の統合は別途必要です。クライアント側検査を認証・認可として扱いません。

- `updateMe({ display_name }, csrfToken, signal?)`は表示名だけ、`acceptTerms({ terms_version, accepted: true }, csrfToken, signal?)`は利用者が確認・同意した版だけを送信。空白のみ・長すぎる表示名・制御文字・偽同意・余分な項目と、Workerの1KiB上限を超えるUTF-8 JSONを送信前に拒否します。表示名や規約版を勝手に整形しません。
- CSRF値は`GET /me`の応答から呼出し側が各更新へ明示的に渡します。32〜256文字のheader安全な可視ASCIIだけを受け付け、欠落/不正なら送信せず`FORBIDDEN`。クライアントは生成・永続保存・自動補完しません。呼出し側もURL、ログ、localStorage、IndexedDB、共有cacheへ保存せず、ログアウト時にはメモリ上の状態を破棄してください。
- 固定の`me`/`consents`パスへJSONとイベントID・CSRF headerを送り、`mode`と`credentials`はともに`same-origin`、`redirect: error`、`cache: no-store`を使用。ブラウザの現在originと異なる設定は通信前に拒否します。手作業のCookie/Authorization headerやクロスorigin fallbackはありません。
- HTTP 200かつ検査済みの`Acknowledgement`だけを成功として返します。生成型だけを信頼せず、request/resource UUIDを実行時検査。本人情報とackの余分な応答項目は除外し、エラーはHTTP statusと契約codeが一致する固定メッセージへ限定します。
- 更新を自動再送しません。古い規約で`CONSENT_REQUIRED`となった場合は再取得・再表示し、利用者の新しい明示同意が必要です。取消しや通信失敗でもサーバーで保存済みの場合があるため、失敗を「保存されていない」と断定せず、再GETで状態を確認します。取得済みの本人情報をackだけで勝手に書き換えません。

[HTTP往復試験](test/account-mutations.test.ts)は、取得→表示名変更→再取得→同意→再取得、規約改訂、token欠落、不正入力/応答、認証エラー、redirect拒否、取消し、応答喪失後の状態確認を合成データで検証します。Node/MSWは実Googleセッション・ブラウザのorigin enforcement・サーバーCSRF・実DB受入を証明しません。配備済みWorkerはBearer限定のままで、このクライアントから直接Cookie書込みを有効化できません。既存SSRログインのCookieを新しいAPI用Cookieと同一視しません。

根拠：[Fetch標準のrequest mode](https://fetch.spec.whatwg.org/#concept-request-mode)、[OWASPのCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。API契約は[OpenAPI](../../packages/contract/openapi.yaml)、Workerと追加migrationの実装/未適用境界は[API README](../api/README.md#現行規約の同意保存ローカル実装)を正本とします。

## API用Cookieの発行処理（既定無効）

2026-10-04にWeb内部の`/auth/api-session`を追加しました。[Route Handler](src/app/auth/api-session/route.ts)から[発行処理](src/auth/api-session.ts)を呼びます。イベントAPIとは別のWeb専用経路であり、OpenAPIの本人情報契約を変更しません。**既存のログイン画面・OAuth callback・proxy・ログアウトへは接続していません。設定値の登録・実環境での有効化も未実施です。**

### 設定と送信元の条件

- サーバー専用の`KOKO_API_COOKIE_ENABLED`が小文字の`true`、`KOKO_WEB_ORIGIN`がpath・末尾slash・query・fragment・userinfoを含まない正規のHTTPS originのときだけ有効。公開用`NEXT_PUBLIC_`変数へ置かず、Worker受信側のoriginと一致させます。未設定・不正設定ではPOST/DELETEとも503 `API_SESSION_UNAVAILABLE`、Cookieを変更せずAuthにも接続しません。
- リクエストURLのoriginと`Origin`が設定値へ完全一致し、`X-KOKO-Session-Request: 1`が必要。`Sec-Fetch-Site`があれば`same-origin`だけを許可し、なければOriginと独自headerは引き続き必須です。Host・Forwarded・Refererから補完しません。
- 本文は0byteだけを許可し、query・Authorization headerは受け付けず、利用者が渡したJWT・本人ID・redirect先を採用しません。Next.jsの空POST/DELETEにも存在するストリームを、本文の存在と混同せず終端まで確認します。最初のchunk・読取り失敗・1秒以内に終端しない場合は拒否し、本文全体を蓄積しません。POST/DELETE以外は405 `Allow: POST, DELETE`。CORSは許可しません。送信元・入力の拒否ではCookieを変更しません。
- 独自headerは秘密やWorkerのCSRF tokenではありません。Cookieを初めて発行するときのCSRF対策として、固定OriginとCORS非許可を組み合わせます。Worker書込みのHMAC検証やOAuthのstate/PKCEを代替しません。

### 発行・更新・消去

1. POSTは既存SSR Cookieから`getSession()`でaccess JWTの候補を取得します。保存由来の`session.user`や`expires_at`は認可・寿命の証拠にしません。候補はJWTの3区切り形式、最大3,500文字です。ブラウザのCookie容量に余裕を持たせるため、Worker受信上限より厳しく制限します。
2. **同じJWT**を`getUser(token)`でAuthサーバーと照合し、`getClaims(token)`で署名検証します。Google単独・非匿名・authenticatedを両方で確認し、検証済み本人UUIDとsubの一致、整数のexpが未来であることを検査します。独自JWT検証やブラウザの本人情報へ依存しません。
3. 検証成功時だけ`__Host-koko_session`へ未加工access JWTを設定。`Secure; HttpOnly; Path=/; SameSite=Lax`、Domain属性なし、Max-Ageは検証済みJWTの残り寿命と300秒の短い方、Expiresも同じ期限です。refresh tokenをAPI用Cookieへ入れません。再POSTは同じCookieを更新します。
4. DELETEは同じ送信元検査後にAPI用CookieだけをMax-Age=0で期限切れにし、Auth接続・Supabase signOutは行いません。再実行可能ですが、セッションの失効やアプリ全体のログアウト完了を意味しません。

応答は成功200の`{ ok: true }`または固定の`{ code }`だけで、常に`private, no-store`です。認証不成立401、Google条件違反403、想定外例外500。POSTでAuth処理へ進んだ後の失敗は古いAPI用Cookieも消去します。JWT・refresh token・個人情報・生のAuth例外をJSON・URL・ログへ返しません。SSRの更新CookieはSDK既存方式のままであり、この変更で既存SSR Cookie全体をHttpOnly化したとは扱いません。

[サーバーAuthアダプター](src/auth/server.ts)はこのrouteだけCookie書込み失敗を固定エラーとして伝播する厳密モードを使います。既存の読取り専用Server Componentの動作は維持します。複数Cookieの保存・応答送達を原子的に保証するものではありません。

### 有効化前に残る作業

画面からの発行/期限前更新、更新とログアウトの競合、SSR signOutとAPI Cookie消去・メモリ上CSRF破棄の統合、同一origin転送とAccess保護の両立、実Googleセッションとブラウザでのrefresh・失効を検証してから有効化します。現在のログアウトボタンにこのCookieの削除処理はないため、設定だけ先に有効化してはいけません。

将来停止する場合は、設定を外す前のCookie消去経路と、停止後の既発行Cookie/JWTの扱いを決めます。flagをOFFにするだけでは残存Cookieを消去せず、DELETEも無効になります。Cookieの300秒制限をJWTの即時失効や漏洩対策の代わりにしません。設定・認証・公開範囲・実配備は[保護操作の個別確認](../../AGENTS.md#保護操作の確認)へ分離します。

[発行処理試験](test/api-session.test.ts)はNextResponseの実Cookieシリアライズと合成Auth応答を使用し、未設定、送信元・別資格情報の拒否、本人/署名結果/期限の異常、更新・消去・秘密非出力を検証します。[アダプター試験](test/auth-server.test.ts)はCookie writerの失敗伝播、[Playwright試験](e2e/login.spec.ts)は設定なしの実Next.js HTTP経路の503・Cookie非変更を検査します。成功時のブラウザCookie保存、暗号署名そのもの、SDKの実refresh、実クラウド接続を証明するものではありません。

根拠（2026-10-04確認）：[Next.jsのCookie書込み境界](https://nextjs.org/docs/app/api-reference/functions/cookies)、[Supabase getSessionの注意事項](https://supabase.com/docs/reference/javascript/auth-getsession)、[getUserの本人照合](https://supabase.com/docs/reference/javascript/auth-getuser)、[getClaimsの署名検証](https://supabase.com/docs/reference/javascript/auth-getclaims)、[OWASPの独自headerによるCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#employing-custom-request-headers-for-ajaxapi)。

## Googleログインの検証導線

`/login`からSupabase AuthのGoogle OAuthを開始し、`/auth/callback`でcodeをCookieセッションへ交換します。`/account`は署名検証済みのGoogle単独セッションだけを表示し、ログアウトできます。認証ページは動的応答・非キャッシュです。既存の`/`は外部送信しない撮影検証画面のままであり、利用者向けアプリ全体の認証ゲートではありません。

接続時は[例](.env.example)に従い、SupabaseのProject URLと`sb_publishable_`で始まる公開用キーを設定します。Google Client Secret、Supabase secret/service_roleキー、セッションをここやGitへ保存しません。Supabaseには固定Web URLの`/auth/callback`だけをRedirect URLとして登録済みです。ローカルURLは未登録のため、ローカル実ログイン試験にはその完全URLの追加許可が別途必要です。現在のVercel保護とSupabaseのSite URLは維持しています。

SupabaseのEmail providerは無効化済みです。規約への同意・表示名の画面、Cookie/CSRFを使うAPI実接続、実機のセッション維持・失効試験は後続です。ログイン導線やHTTPクライアントの追加をF1-4全体の完了とは扱いません。

メディアは[認証ゲート](../../docs/decisions/ADR-0002-authenticated-delivery.md)経由。Cookieを通さない公開画像最適化cacheや、署名付きStream URLの直接配布で代替しません。詳細な順序は[FEタスク](../../docs/product/development-plan.md#feタスク)を参照してください。
