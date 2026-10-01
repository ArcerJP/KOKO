# ADR-0003: 個別Worker限定の資格情報によるAPI配備

## 状態

Accepted — 個別Worker限定の資格情報とGitHub Actionsによる配備を採用・適用済み。

2026-09-29、iijimaは移行計画に続き、配備の仕組み・テスト・文書のローカル実装を承認しました。検証完了後、commit・push・PR作成まで追加承認を受けました。通常運用は初回手動検証後のmainマージによる自動配備を選択し、その後、本人による準備・切替・旧資格情報の整理を経て、自動配備を有効化しました。2026-10-02には通常main更新による実配備を確認しています。日付付きの証拠と残る検証は[クラウド準備の進捗](../product/cloud-setup.md#項目別の進捗2026-10-02更新)を正本とします。今後の発行・設定変更・失効も対象ごとの承認が必要であり、このADRは包括的な外部操作許可ではありません。

## 背景

移行検討時、開発用WorkerはWorkers Buildsから初回配備済みでしたが、User API Tokenは対象アカウントのWorkers Adminでした。権限を既存`koko-api-dev`だけに限定する必要がありました。2026-09-29に確認した公式仕様では、Cloudflareの資源単位権限はAccount API Tokenで利用できる一方、Workers BuildsはUser API Tokenだけに対応していました。

## 決定と実装

- APIの配備元だけをGitHub Actionsへ移し、既存Worker1件のWorkers Editorを持つAccount API Tokenを専用Environmentへ保管する。
- Worker・URL・R2 binding・Accessを作り直さない。R2やAccessの管理権限を配備用トークンへ足さない。
- PR検査と実配備を分離し、既存のレビュー・必須checkを維持する。配備workflowはmainのpushと手動実行のみ対象とする。
- 初期の自動配備はOFF。検証した同じSHAを配備し、直前に最新mainとの一致を確認する。Secretは配備stepだけへ渡す。
- 旧Buildsを止めてから初回手動配備を検証し、旧トークン失効の後に自動配備を有効化する。

実行条件の正本は[workflowとガード](../ci.md#開発用api配備)、外部設定・切替・復旧の正本は[クラウド準備](../product/cloud-setup.md#github-actionsへの移行手順外部操作は別途承認)です。

## 検討した代替案

| 案                                            | 利点                                             | 採用しない理由・負担                                |
| --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| 現行BuildsとUser API Tokenを維持              | 配備経路を変更せず保守が少ない                   | 別Workerにも及ぶ権限が残る                          |
| Account API TokenをBuildsへ登録               | 現行経路のまま権限を限定できるなら簡単           | 公式仕様では未対応。登録APIで回避できると推定しない |
| 個別WorkerのAccount API TokenとGitHub Actions | 対象Workerへ権限を限定でき、既存Wranglerを再利用 | workflow・Secret・期限・二重配備防止の保守が増える  |

## 影響

個別WorkerのEditorでも、そのWorkerのコード変更とbinding経由のデータへの影響は可能です。mainのレビューと依存固定が引き続き必要です。Secretsのstep限定は、依存コード侵害への完全な防御ではありません。

新しいCLI・実依存・追加の配備用Actionは導入しません。GitHub Actionsの実行と資格情報の管理は増えるため、適用前に実行先と利用条件を確認します。トークンが失効すると次の配備は止まりますが、稼働中Workerの利用者認証をこの配備用トークンへ依存させません。Cloudflare AccessはKOKO利用者向けGoogle認証とは別です。

ローカルのモック・dry-run試験は、Account API Tokenの実配備互換性、Cloudflare Accessの維持、実R2操作の成功を証明しません。初回切替は本人による実環境受入が必要です。

## 参照資料

- [Cloudflare：Wranglerの資源単位権限](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler)
- [Cloudflare：BuildsのAPI Token制限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
- [Cloudflare：GitHub Actionsからの配備](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [GitHub：安全なworkflow](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub：Environmentと配備保護](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

公式仕様は2026-09-29に確認。適用時にも対応状況を再確認します。
