# 第6要件以降のiOS・Android対応準備

2026-09-22の追加指示に基づく設計境界です。第6要件からアプリ版の導入へ進む方針であり、配信日・フレームワーク・ストア申請を確定したものではありません。現時点ではWeb版を優先し、ネイティブ実装用の空ディレクトリや依存関係を追加しません。

同日の確認回答で、選定済み構成を維持し、Web版はGoogleのみ、nativeの追加ログイン手段は第6着手前に決定することをiijimaが承認しました。

## 今から維持する境界

| 共通にするもの                                     | プラットフォームごとに分けるもの                               | 現在の対応                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| OpenAPI、状態・権限・エラー、event_idと内部user_id | Web UI / iOS UI / Android UI                                   | `packages/contract`は純粋TypeScript。LintでUI・主要SDK依存を拒否                    |
| Workers APIの認可、DB、処理ジョブ                  | Cookieセッション / 端末の安全なトークン保管                    | APIはCookieとBearerの両契約。認証済み主体を業務ロジックへ渡す                       |
| 投稿ID・冪等キー・再送の意味                       | OSカメラ、メディア読取、トリム、IndexedDB / 端末ファイルキュー | 再試行で別投稿を増やさない。端末が中断した送信を再開可能にする                      |
| 認証配信・停止・BANの効力                          | ブラウザvideo / native playerの認証・Range・HLS処理            | 公開URLへ緩和しない。全子リソースで認証できるか実機で確認                           |
| 色・余白・状態表現の意味                           | CSS rem / nativeの単位・文字拡大・safe area                    | 現在の正本はWeb CSS。native採用時に中立データへ移して生成し、手書き二重管理を避ける |

Next.js Server ActionsやブラウザのDOM/IndexedDBへ業務APIを閉じ込めません。Next.jsをnativeアプリ内でそのまま実行できるとは見なしません。TypeScript以外を選ぶ場合もOpenAPIから対応する型を生成し、認可の正本はBEに保ちます。

## 認証・配信・互換性

- ユーザーの業務IDはSupabaseの`auth.users.id`。メールやGoogle固有IDを投稿の主キーにしません。別providerの追加・アカウント連携・BAN迂回対策は別の承認と試験が必要です。
- Web版のGoogleのみという要件は、追加承認なしに変更しません。nativeのOAuth復帰先はWeb callbackと分離し、許可リストとPKCE/state検証を行います。Google OAuthを埋込みWebViewへ直接表示しません。[GoogleのOAuth方針](https://developers.google.com/identity/protocols/oauth2/policies)、[Supabaseのnative deep link](https://supabase.com/docs/guides/auth/native-mobile-deep-linking)を実装時にも再確認します。
- nativeは信頼済み設定のHTTPS API originと相対メディアパスを組み合わせます。レスポンスに含まれる任意hostへBearerを送らず、別originへのredirectにも認証情報を転送しません。
- playerの初回manifestだけでなくsegment、子playlist、鍵、初期化データ、Range要求すべてでセッションを検証する必要があります。Bearerが全要求に伝搬するとは推測せず、検証済みplayer adapterまたは安全なCookie方式を第6のスパイクで選定します。短命の署名URLを配るだけの代替は[ADR-0002](../decisions/ADR-0002-authenticated-delivery.md)を満たしません。
- アプリの更新には時間差があるため、公開後のAPIは追加的変更を優先します。破壊的変更の前に旧版対応期間・新API版・廃止案内を決定し、対応中の旧クライアントとの契約試験をCIに追加します。未公開0.1.0の段階で根拠のないサポート年限は設定しません。

## 第6着手前の判断と受入ゲート

1. 実装方式を比較する。TypeScript系クロスプラットフォームは契約・言語の共有が利点、player/カメラ等のnative連携検証が負担。Swift/Kotlin個別実装はOS機能の直接利用が利点、2実装と型生成・保守が負担。単純WebView化は共有量が多くても認証・バックグラウンド・審査上の制約があり、同等の代替とは扱わない。採用は実機検証・工数比較後に人間が決める。
2. iOSの追加ログイン手段を判断する。第三者ログインには条件を満たす別手段が必要な場合があり、一般来場者向けKOKOが教育機関アカウント限定の例外に該当するとは推測しない。Appleログイン等の追加、連携、解除、重複アカウントの扱いを決める。[Apple 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)
3. アカウント削除の契約・画面・処理を追加する。現在の「投稿削除」だけで退会完了とはしない。アプリ内からの削除開始と、Google Play用のWeb導線、認証失効、外部ID連携解除、保持例外と削除期限を整備する。原本lock・監査保持との矛盾は適用前に人間へ確認する。[Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app)、[Google Play](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
4. 投稿型サービスの通報・ブロック・運営連絡先、年齢区分、カメラ/写真権限、プライバシー表示とAIへの送信同意を再評価する。管理者BANだけで全ストア要件を満たすとは判断しない。[Apple審査規則](https://developer.apple.com/app-store/review/guidelines/)
5. iOS/Androidでログイン復帰、更新/失効、撮影、キュー復帰、認証HLS/MP4、BAN/非表示、旧版互換を検証する。画面停止後の送信継続をOS制約なしに保証しない。
6. 公開主体、登録アカウント、署名資格情報、実機、ストア料金・審査期間、サポート担当を人間が確定する。現時点では登録・課金していない。

## 現在の限界

共有契約と設計境界を用意しただけで、nativeアプリ、player adapter、追加ログイン、退会機能は未実装です。ストア規則は2026-09-22に一次資料で確認したものを示し、提出時の再確認と審査は別です。
