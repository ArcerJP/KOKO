# 永続的なプロジェクトメモリ

- KOKO自体がリポジトリルートです。入れ子のKOKO/KOKOルートを作成しません。
- OpenAI Codexを主要なAI開発環境とします。
- KOKOは、docs/architecture/five-patterns.mdに記載された5パターンのワークスペースアーキテクチャを採用します。
- 第49回技科大祭向け写真・動画共有アプリの要件と構成を選定済みです。現在の正本はdocs/product/とdocs/architecture/product-architecture.md、決定はADR-0001/0002です。
- 第0日の成果物・承認状況はdocs/product/day-zero.mdを参照します。契約整備と本番実装を区別します。
- 第6要件のiOS/Android準備はdocs/architecture/native-readiness.md、動画短縮と費用判断はdocs/product/cost-policy.md、反復手順はcost-review Skillを参照します。
- knowledge/raw/には証拠を、knowledge/wiki/には導出した知識を保存します。
- タスク状態はwork/inbox/、work/notebook/、work/outbox/、work/archive/の順に移動します。
- Codexネイティブなリポジトリ指示にはAGENTS.mdを、リポジトリSkillsには.agents/skills/を使用します。
- 他のAI IDEとの互換性は、実際の移行が依頼されるまで保留します。

このファイルは簡潔かつ公開可能な内容に保ちます。現在の詳細なアーキテクチャはdocs/、タスクコンテキストはwork/、一時的なコンテキストはmemory/に保存します。
