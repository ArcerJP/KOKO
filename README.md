# KOKO

## 概要

KOKOは、プロジェクトの成長後も指示、証拠、知識、計画、実装、メモリ、タスク状態を区別して管理するための、Codexネイティブなワークスペース基盤です。

## 現在の状態

このリポジトリには現在、AIネイティブなワークスペースアーキテクチャだけが含まれています。プロダクトの目的、技術スタック、アプリケーション構成、データベース、インフラストラクチャ、デプロイモデルは未決定です。

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

AGENTS.mdは簡潔なリポジトリルーティングを提供します。下位のAGENTS.mdは、そのサブツリーに限ったルールを追加します。.agents/skills/配下の5つのSkillsは、タスク固有の手順を提供します。

## Git / GitHub

既定ブランチはmainとし、直接pushしません。作業ブランチとPull Requestを使用し、ブランチ名、commit、Pull Requestタイトル、同期、merge後の削除は.agents/skills/git-workflow/SKILL.mdに定めたプロジェクト固有の形式に従います。秘密情報や非公開の作業資料をcommitしてはいけません。GitHubの所有者と公開範囲は、ユーザーが明示的に決定します。

## フォーマット

EditorConfigとPrettierで改行、空白、インデントを統一します。Huskyとlint-stagedがcommit時にステージ済みファイルを整形し、GitHub ActionsがPull Requestを検査します。初回セットアップと操作方法はdocs/formatting.mdを参照してください。

## CI

Pull Requestの作成・更新時とmerge queueでGitHub Actionsを実行します。現在はPrettierによるformat検査とMarkdownlintによる文書の静的解析を導入済みです。ユニット／統合テスト、プロダクト言語固有のLinter、型チェック、production buildは、プロダクトの技術と実行対象を決定した時点で実装と同時に追加します。現在の対応状況と導入条件はdocs/ci.mdを参照してください。

## KOKOの拡張

トップレベルディレクトリ、指示レイヤー、Skillを追加する前に、.agents/skills/evolve-workspace/SKILL.mdとdocs/architecture/extension-policy.mdに従ってください。

## 可搬性

現在のKOKOはCodexネイティブです。他のAI IDE用アダプターは意図的に含めておらず、実際の移行依頼があった場合に限り設計します。docs/architecture/portability.mdを参照してください。
