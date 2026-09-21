# 第0日：キックオフと契約合意

対象期間：2026-09-21〜09-22。対象資料：開発計画書v1.0 §2。

## 現在の状態

**K-01〜K-08は作成・ローカル検証を終え、2026-09-22にiijimaがFE・BE双方として一式を承認しました。第0日の契約合意は完了です。**

根拠は、前回提示した成果物一式への「すべて承認する」と、規則に従ったcommit・push・PR作成を進めてよいという回答です。本番資源や実機の準備、PRのmerge、後続段階の機能実装はこの承認に含めません。

## K-01〜K-08チェックリスト

| ID   | 成果物                                                                                                  | 作成・検証                                                                         | 最終合意     |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| K-01 | [初期SQL](../../apps/api/supabase/migrations/20260921000000_initial_contract.sql)                       | 全14テーブルevent_id・RLS、複合FK、キー/UID、counter。PGliteで適用・制約・権限試験 | 承認済み     |
| K-02 | [OpenAPI](../../packages/contract/openapi.yaml)・[生成型](../../packages/contract/src/generated/api.ts) | OpenAPI lint、型生成差分、TypeScript strict/build。API本体は未実装                 | 承認済み     |
| K-03 | [状態・権限](../../packages/contract/README.md)・[policy.ts](../../packages/contract/src/policy.ts)     | 遷移、fail-closed、動画長、通報、権限をテスト                                      | 承認済み     |
| K-04 | [キー契約](../../packages/contract/src/keys.ts)                                                         | UUID限定・パス/URL拒否、SQLとの整合性                                              | 承認済み     |
| K-05 | [エラーコードと画面文言](../../packages/contract/ERRORS.md)                                             | errors.tsから生成、API enumとの一致を試験                                          | 承認済み     |
| K-06 | [実行環境](../architecture/product-architecture.md)                                                     | Vercel / Workers / Cloud Runを2026-09-21回答で決定                                 | 承認済み     |
| K-07 | [初期トークン](../../apps/web/src/styles/tokens.css)・[FE案内](../../apps/web/README.md)                | 色・文字・余白・角丸・動きを減らす設定。主要文字色のコントラスト試験               | 初版承認済み |
| K-08 | [配置](../architecture/directory-map.md)・[Git運用](../../.agents/skills/git-workflow/SKILL.md)         | npm workspaces、既存の作業ブランチ/PR規約を継続                                    | 承認済み     |

## ユーザー回答を反映した決定

| 項目           | 2026-09-21の回答・扱い                        | 反映先                       |
| -------------- | --------------------------------------------- | ---------------------------- |
| 実行環境       | FE Vercel、API Workers、画像Cloud Runで進める | ADR-0001                     |
| 通報の矛盾     | 1件で非表示、2件目で追加通知                  | ADR-0001、状態契約           |
| 配信の公開範囲 | 配信時も必ず認証。公開URL方式を不採用         | ADR-0002、OpenAPI、要件/計画 |
| BAN時の扱い    | 非公開と削除を分ける。解除だけで再公開しない  | ADR-0001、状態/DB契約        |
| レビュー担当   | iijimaがFE・BEの両方を承認                    | この文書                     |

## 承認対象と追補

1. [要件](requirements.md)が対象を漏らさず、[開発計画](development-plan.md)の第1以降を今回の実装済みと扱っていないこと。
2. API・DB・状態・エラー・キーをFE/BE共通契約として使用すること。型はOpenAPIから生成し、実装側で認可と入力検証を省略しないこと。
3. 認証ゲートの採用と、配信性能/費用の追加試験。初期色はインディゴ、本文16px相当・4px基準の余白、カード角丸16px相当というK-07初版。
4. 承認後の変更は契約正本とテストを先に更新し、FE/BE双方の合意を得ること。

承認者：iijima（FE/BE）。承認日：2026-09-22。承認対象：K-01〜K-08初版、共有契約0.1.0。承認時点は`140d116`を基点とする作業ブランチ上の未commit成果物であり、存在しない承認時commit SHAは記載しません。公開する確定版はこの変更を含むPRのcommit履歴で追跡します。

同日の追加指示により、[第6要件のnative対応準備](../architecture/native-readiness.md)、[動画短縮・費用比較](cost-policy.md)を追補しました。将来のフレームワーク、追加認証、予算、候補の節約案まで採用済みとは扱いません。

## 後続段階で決める事項

| 事項                                                        | 決定期限                | 現在の扱い                                            |
| ----------------------------------------------------------- | ----------------------- | ----------------------------------------------------- |
| ドメイン、クラウドアカウント、公開主体、予算                | 第1の外部環境作成前     | 秘密の値をリポジトリへ置かない                        |
| HEIC decoder、Mediabunnyの実機成功、同一origin Cookie/Range | 第1スパイク             | 成功を推測せず実測                                    |
| HLS/MP4、3.8/3.5/3.0秒の比較                                | 第1〜第2実測後          | 公開上限4秒。5秒延長は不採用、必要なら別承認          |
| nativeの実装方式・認証・退会・ストア対応                    | 第6着手前               | [対応準備](../architecture/native-readiness.md)を検証 |
| Discordチャンネル、容量アラート閾値                         | 第2〜第3の運用設定前    | 200GBは仮案、WebhookはSecret                          |
| AI閾値・過検知目標・並列度                                  | 第3校正後、公開前       | 200枚以上、5%以下は未確定の目標                       |
| BLOCK原本保持とBucket Lock期間                              | 第3のlock適用前         | BLOCK30日案と長期lockの衝突を要確認                   |
| 正常系サンプル、規約、会場掲示、連絡先                      | 10/3、10/5、10/7        | [人間の作業](development-plan.md#人間の作業と期限)    |
| 自己いいね、追加演出                                        | 第4実装前               | 未決。初期counterは0                                  |
| exportの対象・保存先権限・実施日                            | 実行前、終了後1か月以内 | 公開済みのみ案、メール/Google ID除外                  |

## 検証と限界

ローカルの契約/SQLテスト、OpenAPI lintと生成一致、ESLint、TypeScript strict、契約build、Prettier、Markdownlintを[CI](../ci.md)のコマンドで確認します。コマンド結果と未実施項目はタスクの引き渡し記録へ残します。

2026-09-21のローカル検証：25テスト成功・失敗/skip 0、上記の静的検証/buildはすべて成功。lockfileからの再installも成功し、npm auditの検出は0件でした（脆弱性が存在しない保証ではありません）。元資料の要件ID 141件とFE/BEタスクID 56件の記載先も照合しました。

2026-09-22の追補検証：動画の短縮目標と共有契約の環境依存拒否を加え、27テスト成功・失敗/skip 0。OpenAPI/生成一致、Lint、型、契約build、整形、Markdown検査も成功。費用比較Skillは標準検証スクリプトを通過しました。これは実トリムや料金削減の実証ではありません。

PGliteによるSQL実行はSupabase本環境・Google OAuth・認証配信の実機試験ではありません。API/UIのproduction build、Cloud RunのDocker image、クラウド配備、費用計測は未実施です。新しいGitHub Actions jobはpush後の実行確認と、管理者によるmain必須check登録が必要です。
