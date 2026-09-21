# KOKO

## 概要

KOKOは、第49回技科大祭向けの写真・動画共有Webアプリです。プロジェクトの成長後も指示、証拠、知識、計画、実装、タスク状態を区別するCodexネイティブなワークスペース上で開発します。

## 現在の状態

第0日の共有契約（初期SQL、OpenAPIと生成型、状態・キー・エラー、トークン、構成）は作成・検証・合意が完了しました。起動可能なアプリ、Google OAuth、クラウド資源の構築は第1要件以降です。契約buildの成功をアプリ完成とは扱いません。

- [プロダクト要件](docs/product/requirements.md)
- [開発計画・FE/BEタスク](docs/product/development-plan.md)
- [第0日チェックリストと承認状況](docs/product/day-zero.md)
- [FE/BE共有契約](packages/contract/README.md)
- [採用構成・信頼境界](docs/architecture/product-architecture.md)
- [第6要件からのiOS/Android対応準備](docs/architecture/native-readiness.md)
- [動画短縮・費用と代替案](docs/product/cost-policy.md)

## ローカル検証

Node.js 24系とnpmを使用します。秘密情報やクラウドアカウントなしで契約を検証できます。

```powershell
npm.cmd ci
npm.cmd run format:check
npm.cmd run lint:md
npm.cmd run contract:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

OpenAPIやエラー定義を更新した場合は`npm.cmd run contract:generate`で派生物を生成します。実アプリを起動する`dev`コマンドはまだありません。

## 主要なAI環境

OpenAI Codexを、Codex CLIとCodex IDE拡張機能に共通する正式なAI開発環境とします。リポジトリの指示にはAGENTS.mdを使用し、反復可能なワークフローには.agents/skills/配下のリポジトリSkillsを使用します。

## 設計思想

KOKOは次の5つのパターンを組み合わせます。

1. リポジトリ、ディレクトリ、タスクにまたがる指示の階層化。
2. 原証拠と導出した知識の分離。
3. 非自明な作業における、調査、計画、実装、検証、レビュー。
4. AIの価値観、役割、ユーザーコンテキスト、ツール、メモリの分離。
5. inbox、notebook、outbox、archiveによるタスクライフサイクル。

このアーキテクチャは段階的開示を採用しています。各構造は存在しますが、Codexが読み込むのは関連する場合だけです。

## ディレクトリ概要

```text
KOKO/
├── AGENTS.md              リポジトリ全体のCodexルーティング
├── .agents/skills/        反復可能なCodexワークフロー
├── apps/web/              FE領域（現在は初期トークン）
├── apps/api/              BE領域（現在は初期SQL）
├── packages/contract/     OpenAPI・生成型・契約・テスト
├── docs/                  正式な文書とADR
├── knowledge/raw/         原証拠（プライベート優先）
├── knowledge/wiki/        導出した再利用可能な知識
├── work/                  タスクライフサイクル成果物（プライベート優先）
├── memory/                一時的なローカルメモリ（プライベート優先）
└── MEMORY.md              永続的で公開可能な継続情報
```

正式な登録情報はdocs/architecture/directory-map.mdを参照してください。

## 知識のライフサイクル

原資料はknowledge/raw/へ取り込みます。再利用可能な統合知識は、出典情報とともにknowledge/wiki/へ記載します。原証拠は、そこから導出した要約よりも優先されます。

## 作業のライフサイクル

タスクは複製せず、次の順に移動します。

```text
inbox → notebook → outbox → archive
```

動的なタスク内容はローカルに保持し、既定ではGitの追跡対象外です。

## Codexへの指示

AGENTS.mdは簡潔なリポジトリルーティングを提供します。下位のAGENTS.mdは、そのサブツリーに限ったルールを追加します。.agents/skills/配下のSkillsは、タスク管理・調査実装・知識取込・Git・構成変更・費用比較の手順を提供します。

## Git / GitHub

既定ブランチはmainとし、直接pushしません。作業ブランチとPull Requestを使用し、ブランチ名、commit、Pull Requestタイトル、同期、merge後の削除は.agents/skills/git-workflow/SKILL.mdに定めたプロジェクト固有の形式に従います。秘密情報や非公開の作業資料をcommitしてはいけません。GitHubの所有者と公開範囲は、ユーザーが明示的に決定します。

## フォーマット

EditorConfigとPrettierで改行、空白、インデントを統一します。Huskyとlint-stagedがcommit時にステージ済みファイルを整形し、GitHub ActionsがPull Requestを検査します。初回セットアップと操作方法はdocs/formatting.mdを参照してください。

## CI

Pull Requestとmerge queueでPrettier、Markdownlint、OpenAPI/生成物、ESLint、TypeScript、契約単体/SQL統合テスト、契約buildを検査します。Web/APIのproduction buildとCloud Runのimage buildは実装導入時に追加します。適用範囲と必須check登録は[CI規約](docs/ci.md)を参照してください。

## KOKOの拡張

トップレベルディレクトリ、指示レイヤー、Skillを追加する前に、.agents/skills/evolve-workspace/SKILL.mdとdocs/architecture/extension-policy.mdに従ってください。

## 可搬性

現在のKOKOはCodexネイティブです。他のAI IDE用アダプターは意図的に含めておらず、実際の移行依頼があった場合に限り設計します。docs/architecture/portability.mdを参照してください。
