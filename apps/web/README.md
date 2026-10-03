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

[client.ts](src/api/client.ts)は生成型の`getMe`、`updateMe`、`acceptTerms`を提供します。2026-10-04に更新2操作を追加しました。現段階では画面・実Cookieサーバーに接続しておらず、合成HTTP試験の完了です。Cookie発行・セッション束縛CSRF検証・Origin検証を実装するサーバーは別途必要です。クライアント側検査を認証・認可として扱いません。

- `updateMe({ display_name }, csrfToken, signal?)`は表示名だけ、`acceptTerms({ terms_version, accepted: true }, csrfToken, signal?)`は利用者が確認・同意した版だけを送信。空白のみ・長すぎる表示名・制御文字・偽同意・余分な項目と、Workerの1KiB上限を超えるUTF-8 JSONを送信前に拒否します。表示名や規約版を勝手に整形しません。
- CSRF値は`GET /me`の応答から呼出し側が各更新へ明示的に渡します。32〜256文字のheader安全な可視ASCIIだけを受け付け、欠落/不正なら送信せず`FORBIDDEN`。クライアントは生成・永続保存・自動補完しません。呼出し側もURL、ログ、localStorage、IndexedDB、共有cacheへ保存せず、ログアウト時にはメモリ上の状態を破棄してください。
- 固定の`me`/`consents`パスへJSONとイベントID・CSRF headerを送り、`mode`と`credentials`はともに`same-origin`、`redirect: error`、`cache: no-store`を使用。ブラウザの現在originと異なる設定は通信前に拒否します。手作業のCookie/Authorization headerやクロスorigin fallbackはありません。
- HTTP 200かつ検査済みの`Acknowledgement`だけを成功として返します。生成型だけを信頼せず、request/resource UUIDを実行時検査。本人情報とackの余分な応答項目は除外し、エラーはHTTP statusと契約codeが一致する固定メッセージへ限定します。
- 更新を自動再送しません。古い規約で`CONSENT_REQUIRED`となった場合は再取得・再表示し、利用者の新しい明示同意が必要です。取消しや通信失敗でもサーバーで保存済みの場合があるため、失敗を「保存されていない」と断定せず、再GETで状態を確認します。取得済みの本人情報をackだけで勝手に書き換えません。

[HTTP往復試験](test/account-mutations.test.ts)は、取得→表示名変更→再取得→同意→再取得、規約改訂、token欠落、不正入力/応答、認証エラー、redirect拒否、取消し、応答喪失後の状態確認を合成データで検証します。Node/MSWは実Googleセッション・ブラウザのorigin enforcement・サーバーCSRF・実DB受入を証明しません。現在のBearer限定Workerの`GET /me`にはCSRF値がないため、このクライアントから直接Cookie書込みを有効化できません。

根拠：[Fetch標準のrequest mode](https://fetch.spec.whatwg.org/#concept-request-mode)、[OWASPのCSRF対策](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。API契約は[OpenAPI](../../packages/contract/openapi.yaml)、Workerと追加migrationの実装/未適用境界は[API README](../api/README.md#現行規約の同意保存ローカル実装)を正本とします。

## Googleログインの検証導線

`/login`からSupabase AuthのGoogle OAuthを開始し、`/auth/callback`でcodeをCookieセッションへ交換します。`/account`は署名検証済みのGoogle単独セッションだけを表示し、ログアウトできます。認証ページは動的応答・非キャッシュです。既存の`/`は外部送信しない撮影検証画面のままであり、利用者向けアプリ全体の認証ゲートではありません。

接続時は[例](.env.example)に従い、SupabaseのProject URLと`sb_publishable_`で始まる公開用キーを設定します。Google Client Secret、Supabase secret/service_roleキー、セッションをここやGitへ保存しません。Supabaseには固定Web URLの`/auth/callback`だけをRedirect URLとして登録済みです。ローカルURLは未登録のため、ローカル実ログイン試験にはその完全URLの追加許可が別途必要です。現在のVercel保護とSupabaseのSite URLは維持しています。

SupabaseのEmail providerは無効化済みです。規約への同意・表示名の画面、Cookie/CSRFを使うAPI実接続、実機のセッション維持・失効試験は後続です。ログイン導線やHTTPクライアントの追加をF1-4全体の完了とは扱いません。

メディアは[認証ゲート](../../docs/decisions/ADR-0002-authenticated-delivery.md)経由。Cookieを通さない公開画像最適化cacheや、署名付きStream URLの直接配布で代替しません。詳細な順序は[FEタスク](../../docs/product/development-plan.md#feタスク)を参照してください。
