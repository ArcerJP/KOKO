# プロダクトアーキテクチャ

2026-09-22時点の選定と、承認済みの第0日契約の実装境界です。実装状況は[開発計画](../product/development-plan.md)、決定履歴は[ADR-0001](../decisions/ADR-0001-product-baseline.md)と[ADR-0002](../decisions/ADR-0002-authenticated-delivery.md)を参照してください。

## 実行先と責務

| 領域           | 採用する構成                               | 第0日の成果物                       | 後続の実装                                                         |
| -------------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| FE             | Next.js App Router・TypeScript、Vercel     | `apps/web`のトークン                | UI・OAuth callback/セッション・MSW・実機検証                       |
| API            | TypeScript、Cloudflare Workers             | `apps/api`のSQL、共有API契約        | 認証/認可、原本PUT署名、状態、管理API、配信ゲート                  |
| DB/認証        | Supabase Postgres・Auth（Googleのみ）      | 全14テーブル・RLSと適用テスト       | プロジェクト作成、OAuth、migration適用、実JWT統合試験              |
| 原本/派生物    | Cloudflare R2の別々の非公開バケット        | キー命名、資産/保持/削除メタデータ  | PUT/multipart、lock、変換、内部cache、失効                         |
| 画像処理       | Google Cloud Run、Node.jsコンテナ          | 実行境界の決定                      | HEIC decodeスパイク、Dockerfile、image build CI、1024/600/1600生成 |
| 動画処理       | Cloudflare Stream                          | 原本/取込UID/clip UID・duration契約 | 取込、clip、署名webhook、HLS/MP4検証                               |
| 非同期処理     | Cloudflare Queues＋DB outbox               | outboxのスキーマと原子性契約        | 配送・再試行・重複排除・取りこぼし回収                             |
| モデレーション | OpenAI・Google Cloud Vision SafeSearch/OCR | 合議・fail-closedの契約             | アダプター、quota/timeout、校正と当日調整                          |
| 運営           | Discord、管理画面。後日rclone→Google Drive | 監査/通知/保持の契約                | webhook、運用script、会場運営、export                              |
| 共通           | npm workspaces・TypeScript                 | `packages/contract`、型/テスト/CI   | FE/BEから共通import                                                |

TypeScriptは型生成ツールのpeer範囲を優先して5.9.3を固定しています。Next.jsや画像ライブラリの実行依存は第1要件で検証して追加します。契約パッケージにブラウザDOMやNode専用APIを混ぜず、WorkersとFE双方で使える純粋な契約を保持します。

第6要件からのiOS/Androidは同じAPI/DBを利用する方針です。[クライアント境界・認証・ストア対応](native-readiness.md)を維持し、現Web UIやCookie方式に業務ロジックを閉じ込めません。実装方式は未選定です。動画長と配信方式の選択には[費用方針](../product/cost-policy.md)を適用します。

## 信頼境界

```text
ブラウザ ── Googleログイン ── Supabase Auth
   │
   ├─ 同一origin API/メディア要求 ── Workers（毎回認証・認可）
   │                                    ├─ Postgres（状態・権限・outbox）
   │                                    └─ 内部cache → 非公開R2 / 署名必須Stream
   │
   └─ 限定PUT/multipart署名 ── 非公開R2原本
                                   │
                         outbox → Queues → Cloud Run / Stream
                                              │
                                   AI判定・実測 → 状態の確定
                                              └─ Discord通知
```

FEの配信はVercel、API/メディアは同一originの経路からWorkersへルーティングします。ルーティング方式の具体設定とCookie/Rangeの伝搬をB1-8で検証し、外向きキャッシュを無効化します。rewriteを認証機構と見なしません。FE側のOAuth callback/セッション処理はNode runtimeを基本とし、メディアの主処理をNext.jsのServer Actionへ載せません。

認証Cookieを利用するメディアは、公開のNext.js画像最適化経路へ流さず、認証ゲートを直接参照する`Image unoptimized`等で扱います。共有画像変換cacheがログイン境界を迂回しないことを否定系で検証します。

## 重要な整合性

- JWT検証だけでなく、対象イベント・本人/権限・投稿/公開停止を確認。service_roleのDB利用にはAPI認可が必要です。
- DB変更、counter、監査、外部処理の予約はtransaction。Queues/webhookは少なくとも1回の配送を前提に、post/version/jobキーで冪等化します。
- Stream webhookは上流の署名を検証し、timestampと重複を確認。古い処理版からのcallbackでdeletedやBAN済み投稿を公開しません。上流payloadの正本はベンダー文書であり、外部から送られたuser_idやevent_idだけを信用しません。
- Cloud Runへの処理依頼はサービス間認証と許可された対象キーで限定。任意URL fetchを禁止し、SSRFを防止。原本URLがStream取込に必要な場合も短命・サーバー間限定・ログ除外とします。
- 画像の原本と配信物を分離し、通常動画はトリム後原本、fallbackは全長原本を保管。clipのUID、署名設定、削除期限は独立管理します。
- 認証後の内部cache hitは許可しますが、公開停止やBAN確認を省略しません。毎回の認可負荷と上流帯域の節約を別々に測定します。
- K-01に将来counterの器を用意しても、like/王冠の原子更新実装は第4要件です。実装されていない保証をschemaから推論しません。

## 秘密・環境設定

Supabase service key、R2/S3署名資格情報、Stream API/署名鍵、Cloud Runサービス間資格情報、OpenAI/Vision資格情報、Discord webhookをSecretストアへ分離します。Git、DBの設定JSON、FE bundle、ログ、PRへ値を含めません。`NEXT_PUBLIC_`へ秘密を入れません。

開発/検証/本番のDB・バケット・origin・OAuth redirectを分離。未確定のドメイン・project ID・予算・lock期間を仮の本番値で埋めません。外部リソースの作成と権限付与は第1要件で承認後に行います。

## 一次資料（2026-09-21確認）

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：grants/RLSとservice_roleの境界。
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)：single uploadとmultipartのサービス上限。
- [Stream clip](https://developers.cloudflare.com/stream/edit-videos/video-clipping/)：新UIDとclip出力の設定。
- [R2 Bucket Lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)：保持中の削除禁止。
- [Vercel rewrites](https://vercel.com/docs/routing/rewrites)：外部originへのルーティング。認証ゲート自体はKOKOで実装する設計です。
- [Supabase SSR advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)：セッション・cache注意事項。KOKOのCookie経由配信は独自の設計境界であり、標準SSRクライアントを置くだけでは完成しません。
