# ツールの指針

## 現在のツール区分

- OpenAI Codex：主要なAI開発環境。
- Git：ローカルのバージョン管理。変更前に状態を確認します。
- GitHub CLI：任意のGitHub連携。使用前に利用可否と認証状態を確認します。
- Node.js／npm workspaces：品質管理、TypeScript共有契約の生成・lint・型・build・テスト環境。実行依存の追加は採用構成と開発計画に従います。
- EditorConfig／Prettier：改行、空白、インデントの統一。
- Markdownlint：Markdown文書の構造と記法の静的解析。
- TypeScript／openapi-typescript／Redocly：共有型とOpenAPIの生成・整合性検証。
- ESLint／Node test runner／PGlite：契約ロジックとSQL・RLSのローカル検証。実Supabase/Authの試験とは区別します。
- 実行先・未導入ツールはdocs/architecture/product-architecture.md、導入段階はdocs/product/development-plan.mdを参照します。

## 利用ルール

- ツールの動作については、最新の公式文書を優先します。
- 使用時点でインストール済みの機能を確認し、記録されたバージョン番号を現在の事実として扱いません。
- 技術選定前に、プロダクト固有のツールやパッケージを推測でインストールしません。リポジトリ運用ツールは、責務と検証方法を明確にした上で追加します。
- リポジトリ品質管理ツールはpackage.jsonとpackage-lock.jsonで固定し、通常の再現導入はnpm.cmd ci --include=dev --strict-peer-depsを使用します。依存関係の追加・更新に伴うinstallは別の変更として検証します。共同開発者の初回導入はdocs/collaborator-setup.mdに従います。
- 明示的な許可なく、リポジトリ固有のルールをCodex、Git、IDE、OS、環境のグローバル設定へ書き込みません。
- APIキー、トークン、パスワード、認証情報、秘密鍵、セッションデータ、秘密の値をここへ記録しません。

## GitHub操作ツール

GitHub CLIはPR・check・ログの確認に便利ですが、KOKO開発の必須条件ではありません。2026-09-23、iijimaのPCでは管理者権限を利用できないため導入を見送りました。既存のGit、GitHub連携、ブラウザで作業を継続します。PRのレビューとmergeは人間が行います。

将来導入する場合は[GitHub CLI公式のWindows手順](https://github.com/cli/cli/blob/trunk/docs/install_windows.md)を使用し、`gh --version`と`gh auth status`で確認します。インストールと本人による認証は別の手順です。導入保留中に別方式のインストールやPATH変更を進めません。

追加ツールが必要になった時点で、解決する作業、既存手段との差、費用・保守・権限上の負担を示して提案します。リポジトリ内に固定済みのWranglerやPlaywrightを、理由なくグローバルへ重複導入しません。
