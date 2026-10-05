# プロダクトアーキテクチャ

2026-09-23時点の選定と、承認済みの第0日契約の実装境界です。実装状況は[開発計画](../product/development-plan.md)、決定履歴は[ADR-0001](../decisions/ADR-0001-product-baseline.md)と[ADR-0002](../decisions/ADR-0002-authenticated-delivery.md)を参照してください。

## 実行先と責務

| 領域           | 採用する構成                               | 第0日の成果物                       | 後続の実装                                                          |
| -------------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------- |
| FE             | Next.js App Router・TypeScript、Vercel     | `apps/web`のトークン                | UI・OAuth callback/セッション・MSW・実機検証                        |
| API            | TypeScript、Cloudflare Workers             | `apps/api`のSQL、共有API契約        | 認証/認可、原本PUT署名、状態、管理API、配信ゲート                   |
| DB/認証        | Supabase Postgres・Auth（Googleのみ）      | 全14テーブル・RLSと適用テスト       | プロジェクト作成、OAuth、migration適用、実JWT統合試験               |
| 原本/派生物    | Cloudflare R2の別々の非公開バケット        | キー命名、資産/保持/削除メタデータ  | PUT/multipart、lock、変換、内部cache、失効                          |
| 画像処理       | Google Cloud Run、Node.jsコンテナ          | 実行境界の決定                      | 変換・認証HTTP/Docker/CIをローカル実装。実機・実IAM・R2接続は未受入 |
| 動画処理       | Cloudflare Stream                          | 原本/取込UID/clip UID・duration契約 | 取込、clip、署名webhook、HLS/MP4検証                                |
| 非同期処理     | Cloudflare Queues＋DB outbox               | outboxのスキーマと原子性契約        | 配送・再試行・重複排除・取りこぼし回収                              |
| モデレーション | OpenAI・Google Cloud Vision SafeSearch/OCR | 合議・fail-closedの契約             | アダプター、quota/timeout、校正と当日調整                           |
| 運営           | Discord、管理画面。後日rclone→Google Drive | 監査/通知/保持の契約                | webhook、運用script、会場運営、export                               |
| 共通           | npm workspaces・TypeScript                 | `packages/contract`、型/テスト/CI   | FE/BEから共通import                                                 |

第1要件ではNext.jsの撮影検証画面、Mediabunnyの端末内Worker、生成型を使うAPI境界、MSWのHTTP試験、Googleログイン導線、WorkerのBearer本人情報APIを実装しています。2026-10-04に規約同意APIとDB関数、既定無効のCookie認証・CSRF受信境界、Web内部のCookie発行・更新・削除処理と本人情報中継、API Cookieを含む条件付きログアウトをローカル追加しました。Webではcallbackが作るログイン世代と検証済みAuthセッションを結び付け、終了/再ログイン後の旧発行応答を中継で拒否します（[ADR-0004](../decisions/ADR-0004-web-session-generation.md)）。現在の実装・未完了は[開発計画](../product/development-plan.md)、Cookie発行・終了・中継プロトコルは[Web README](../../apps/web/README.md)、受信・同意保存のtransaction・未適用の境界は[API README](../../apps/api/README.md)を正本とします。本人情報・表示名・規約同意画面は操作時Cookie更新・fresh CSRF・状態破棄を条件付き実装しました。採択本文の一覧は空で、本文/現行版が一致する場合だけ明示同意を許可する設計です。正式本文の採択と実環境でのAccess認証は未完了で、アプリ全体の認証ゲートを完成扱いにしません。ローカル試験と実クラウドの受入証拠は[クラウド準備](../product/cloud-setup.md)、撮影処理と実機の制約は[撮影検証](../product/stage-one-capture.md)へ分離し、ここへ進捗の完全な複製を置きません。

2026-09-29、個別Workerへ配備権限を限定するGitHub Actions workflow・回帰試験・文書をローカル実装し、その後、旧Workers Buildsを切断してActionsへ移行しました。2026-10-02までに初回手動配備と通常main更新による自動配備を確認しています。採用理由は[ADR-0003](../decisions/ADR-0003-worker-scoped-deployment.md)、配備の安全条件は[CI規約](../ci.md#開発用api配備)、外部の適用済み状態・証拠・残る検証は[クラウド準備](../product/cloud-setup.md#項目別の進捗2026-10-02更新)へ分離します。開発用Cloudflare Accessを利用者向けGoogle認証の実装と混同しません。

TypeScriptは型生成ツールのpeer範囲を優先して5.9.3を固定しています。実際の依存バージョンはpackage.jsonとlockfileを正本とします。契約パッケージにブラウザDOMやNode専用APIを混ぜず、WorkersとFE双方で使える純粋な契約を保持します。

第6要件からのiOS/Androidは同じAPI/DBを利用する方針です。[クライアント境界・認証・ストア対応](native-readiness.md)を維持し、現Web UIやCookie方式に業務ロジックを閉じ込めません。実装方式は未選定です。動画長と配信方式の選択には[費用方針](../product/cost-policy.md)を適用します。

画像処理は[apps/image](../../apps/image/README.md)へ分離し、Workers/Webへnative decoderを混入させません。CLIの既定入口を維持し、[ADR-0007](../decisions/ADR-0007-private-image-service.md)に従う認証HTTPをDockerの明示的なservice targetへ追加しました。Google署名・宛先・許可主体を検証して内部runnerへ渡すローカル実装で、実Cloud Run IAM・token取得・DB/R2接続・配備は未受入です。

## 信頼境界

2026-10-06の第1〜第3実装では、DBの投稿版・lease・完了証拠を正本として画像/Stream/AIを接続し、Queue ACKをHTTP成功だけで決めない構成を追加しました。WebのJSON中継とは別に、Range/stream中断を扱う固定メディア中継を設けています。R2原本は非公開のまま、運営権限のある主体による個別取得だけを第3へ含めます。一括export/Drive連携は第5です。管理操作、通知/削除予約、容量監視はAPI/DBに置き、物理削除は既定で実行しません。詳細な設定と未受入条件は[API README](../../apps/api/README.md)、画面とprivate Realtimeの扱いは[Web README](../../apps/web/README.md)を参照します。

Realtimeは限定topicの変化通知だけを扱い、投稿本文や権限の正本にしません。受信したら画面の状態を破棄し、通常APIで再認証・再読取りします。処理障害はAIの違反と区別して原本保持の非公開保留へ収束し、現在版を確認した運営者の明示再処理だけを受け付けます。実Cloud Runの呼出元認証・外部Secret・DB/バケット設定・本番負荷受入が済んだという意味ではありません。

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

本人情報3操作とアップロード制御4操作は、明示的なNode Route Handlerで入力・送信先・転送header・応答を制限する中継を採用します。汎用rewriteより検査とサーバー1 hopの負担が増しますが、SSR/Access Cookieや上流の秘密headerを透過せず、クライアントの契約検査を再利用できます。固定開発APIへのAccessサービス認証はサーバー専用設定から付与するローカル実装です（[ADR-0005](../decisions/ADR-0005-web-access-service-auth.md)）。業務認可とDBアクセスはWorkerに残し、このJSON専用経路をメディア/Rangeへ拡張しません。Blobは限定署名でR2へ直接PUTします。既定無効・実受入前の条件は[本人情報中継](../../apps/web/README.md#本人情報の同一origin中継既定無効)と[アップロード転送](../../apps/web/README.md#アップロード制御とr2直接転送f1-5既定無効)へ集約します。

認証Cookieを利用するメディアは、公開のNext.js画像最適化経路へ流さず、認証ゲートを直接参照する`Image unoptimized`等で扱います。共有画像変換cacheがログイン境界を迂回しないことを否定系で検証します。

## 重要な整合性

Webの送信キューは[ADR-0006](../decisions/ADR-0006-durable-browser-upload-queue.md)に基づき、IndexedDB adapterとUI非依存engine、root layout provider、明示送信画面に分離します。画面ライフサイクルと送信を分け、同一本人/eventと固定IDで再開します。保存・retry・秘密非永続・実機制約は[Web README](../../apps/web/README.md#端末内送信キューと投稿画面f1-5f2-1既定無効)が正本です。

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

アカウント・課金・権限の準備と人間の操作は[クラウド準備ガイド](../product/cloud-setup.md)を参照してください。端末内検証画面は秘密や外部サービス接続なしで動作します。

## 一次資料（2026-09-21確認）

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：grants/RLSとservice_roleの境界。
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)：single uploadとmultipartのサービス上限。
- [Stream clip](https://developers.cloudflare.com/stream/edit-videos/video-clipping/)：新UIDとclip出力の設定。
- [R2 Bucket Lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/)：保持中の削除禁止。
- [Vercel rewrites](https://vercel.com/docs/routing/rewrites)：外部originへのルーティング。認証ゲート自体はKOKOで実装する設計です。
- [Supabase SSR advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)：セッション・cache注意事項。KOKOのCookie経由配信は独自の設計境界であり、標準SSRクライアントを置くだけでは完成しません。
