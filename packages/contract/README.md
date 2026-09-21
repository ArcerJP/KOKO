# FE・BE共有契約（第0日）

バージョン0.1.0、初版承認済み。契約を生成・試験できる状態であり、APIサーバーや本番DBの稼働を意味しません。最終合意は[第0日](../../docs/product/day-zero.md)で管理します。

## 正本

| 契約                      | 編集する正本                                                                      | 派生物・確認                                                  |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| K-01 DB・制約・RLS        | [初期SQL](../../apps/api/supabase/migrations/20260921000000_initial_contract.sql) | [SQLテスト](test/database.test.mjs)                           |
| K-02 API                  | [OpenAPI](openapi.yaml)                                                           | [生成TypeScript](src/generated/api.ts)                        |
| K-03 状態・公開条件・権限 | [policy.ts](src/policy.ts)と下記のtransaction境界                                 | [契約テスト](test/policy.test.mjs)                            |
| K-04 キー                 | [keys.ts](src/keys.ts)                                                            | SQLのキー制約・契約テスト                                     |
| K-05 エラーと画面文言     | [errors.ts](src/errors.ts)                                                        | [自動生成の対応表](ERRORS.md)                                 |
| K-06 実行環境             | [プロダクト構成](../../docs/architecture/product-architecture.md)                 | [ADR-0001](../../docs/decisions/ADR-0001-product-baseline.md) |
| K-07 トークン             | [tokens.css](../../apps/web/src/styles/tokens.css)                                | 主要文字色のコントラスト試験                                  |
| K-08 配置・運用           | [ディレクトリマップ](../../docs/architecture/directory-map.md)                    | [Git Skill](../../.agents/skills/git-workflow/SKILL.md)       |

## API共通契約

- `X-Event-ID`で対象を限定し、主体は検証済みJWTの`sub`から取得。Google provider、署名、issuer、audience、期限、イベント所属を確認します。API型の生成はHTTP入力検証の代わりではありません。
- 本人用APIは`private, no-store`。共通feedもブラウザ・Vercel側は`private, no-store`、Worker内部だけ短時間共有cache。キャッシュより前に認証と公開可否を検査します。
- 画像・動画は同一originの`/media/{event_id}/{post_id}/{resource}`。HTMLの画像・videoからはHttpOnly Cookie、APIクライアントからはBearerを使用できます。URLにセッションやStream署名を入れません。詳細は[認証配信ADR](../../docs/decisions/ADR-0002-authenticated-delivery.md)。
- Cookie認証の書込みは、許可Originとセッションに束縛した`X-CSRF-Token`を検証。トークンは`GET /me`の`csrf_token`から取得し、ログ/共有cacheへ入れません。CORSを認証と見なしません。CSRF不正はFORBIDDEN。Supabase OAuth callbackのstate/PKCEも検証します。
- 一覧は`created_at DESC, id DESC`。不透明cursorへイベント・フィルター・位置を束縛し、改ざん・別条件への流用を拒否。未公開/削除/別イベントの投稿は一律NOT_FOUNDとし存在を漏らしません。
- `client_request_id`を本人・イベント単位で一意に保持。同じ内容の再送は同じ投稿を返し、内容違いは409。complete、通知、webhook、like、削除は重複安全にします。
- 入力サイズは文字列やページ件数に技術上の上限を設けますが、メディアの独自容量制限は設けません。実サービス上限はPROVIDER_LIMIT。single/multipartを切り替え、署名は対象キー・メソッド・期限へ限定します。
- OpenAPIの`x-stage`は機能の予定実装段階です。第4・第5の契約を先に用意してもその機能を提供したとは扱いません。

## 状態とtransaction境界

```text
uploading → uploaded → processing → published / published_flagged
    ↓                       └────→ blocked / held
upload_failed                    （再判定はadminの明示操作）

published / published_flagged → hidden → 以前の公開状態
任意の非deleted状態 → deleted（終端、物理削除完了とは別）
```

許可する辺の完全な一覧は`policy.ts`だけで管理します。`assertTransition`は辺の検査であり、認可・公開条件・副作用を代行しません。BEは次の処理を実装し、同一transaction内の競合試験を追加します。

1. 対象event、所有者/運営権限、投稿version、同意、BAN/受付/公開停止を検証。クライアントからstatusやroleを直接指定させない。
2. complete時はR2の実在・サイズ・postとassetの所属を確認。投稿更新と処理outboxの登録を原子的に行う。
3. 公開時は派生物の準備、実測動画長、必須AI結果を検証。BLOCKが最優先、必須結果の欠落/エラー/重複はheld。PASS→published、FLAG→published_flagged。Stream callbackだけで公開しない。
4. 通報は一意制約で重複排除。1件目でhiddenにし以前の公開状態を保存、2件目で追加通知。状態、report_count、配信失効・通知outboxを一緒に更新する。
5. BANはイベント内の利用者を投稿不可にし、過去投稿へ`ban_latched`を設定。公開中はhidden、処理中は公開させない。解除は利用者のBANだけを解除し、投稿を自動復帰させない。
6. hiddenの復帰は保存された判定と`previous_public_status`を使用し、投稿者がBAN中・公開停止中なら拒否。BAN由来のラッチ解除と復帰はadminの明示レビュー操作。BLOCKを直接公開せず再判定へ戻す。
7. deletedは終端。本人または運営の削除で新規配信を直ちに拒否し、派生物/Stream削除を予約。原本lockが残る場合は`retention_until`・削除予約日時と実削除日時を区別する。
8. 公開件数・いいね・王冠などのcounterと状態変更、監査記録を一貫させる。外部処理はcommit後のoutbox consumerで実行し、失敗・重複を再実行可能にする。

重大カテゴリの高スコアBLOCKは即時BAN、それ以外のBLOCKは累積3回。閾値・モデル・対象カテゴリの校正は第3要件で行い、初期DBは公開/受付停止・閾値未承認で開始します。

## DBと権限

初期SQLは14のアプリテーブルを作成し、すべて`event_id`とRLSを持ちます。`events.event_id`がイベント自身の主キーで、Supabase管理の`auth.users`は対象外です。投稿/お題/原本/申立ては複合FKでイベント・所有者を束縛します。

`anon`はアプリテーブルへの権限なし。`authenticated`の直接SELECTは本人のプロフィール/同意/通報/申立て/いいねと所属イベントのお題等に限定します。投稿、原本キー、upload session、判定ログ、監査、設定はWorkers経由です。一般利用者の直接INSERT/UPDATE/DELETEは許可しません。

`service_role`はRLSを回避します。これは[実テスト](test/database.test.mjs)で確認しており、APIで認可を省略してよいという意味ではありません。キーはWorker/サーバーの秘密領域だけに置きます。DBのCHECKだけでは全状態遷移、別行のBAN、counterの原子性は保証しません。

moderatorは監視・非表示・通常復帰・削除、adminは加えてBAN/解除・設定・お題編集・exportを担当します。一般利用者の本人削除・通報・申立ては別の所有者認可です。表示上のボタン非表示だけで権限を守らないでください。

## メディア識別と原本の意味

動画の公開上限は`maxPublishedVideoSeconds`、短縮目標は`videoTrimTargetsSeconds`を正本とします。後者は実機比較用の候補で、公開可否は実測値で判断します。未計測・4秒超を許可する緩和ではありません。[費用比較](../../docs/product/cost-policy.md)の課金単位も確認してください。

元ファイル名・表示名・メールをキーに含めません。新規のUUIDをBEが発行し、原本と派生物の命名は`keys.ts`に従います。Stream UIDはURLにせず別列へ保持。通常動画とfallback全長動画は`original_scope`で区別します。Streamへの全長取込とclip後はそれぞれ`stream_source`と`stream_clip`として追跡します。

原本・派生物バケットとも非公開。AI用の縮小物・フレームは非公開の一時データとして処理後に除去し、原本をAI APIへ送信しません。3フレームは実duration内の先頭・中間・末尾付近を選びます。短縮後の動画に実durationを超える時刻を指定する処理は実装しません。

## 将来のクライアント

共有コードをUI・Node・クラウドSDKから分離し、Web、Workers、将来のnativeから同じ契約を使います。DOM/Nodeの暗黙型を読み込まず、ESLintでも主要な環境依存importを禁止します。認証保管、カメラ、player、端末キューは各アプリの責務です。[native対応準備](../../docs/architecture/native-readiness.md)に従い、ストア版の更新遅延を考慮したAPI互換性を実装時に検証します。

## 生成と検証

リポジトリルートで実行します。

```powershell
npm.cmd ci
npm.cmd run contract:generate
npm.cmd run contract:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

生成型・エラー表は追跡し、`dist/`は追跡しません。生成差分をCIで検出します。SQLテストは実際のPostgreSQLエンジン（PGlite）でmigration・制約・権限/RLSを実行しますが、Supabase Auth本体・OAuth・ネットワーク・配信ゲートは模擬せず、未検証として第1〜第3で確認します。
