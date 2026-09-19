# 永続的なプロジェクトメモリ

- KOKO自体がリポジトリルートです。入れ子のKOKO/KOKOルートを作成しません。
- OpenAI Codexを主要なAI開発環境とします。
- KOKOは、docs/architecture/five-patterns.mdに記載された5パターンのワークスペースアーキテクチャを採用します。
- 技術スタックとプロダクト構成は未選定です。
- knowledge/raw/には証拠を、knowledge/wiki/には導出した知識を保存します。
- タスク状態はwork/inbox/、work/notebook/、work/outbox/、work/archive/の順に移動します。
- Codexネイティブなリポジトリ指示にはAGENTS.mdを、リポジトリSkillsには.agents/skills/を使用します。
- 他のAI IDEとの互換性は、実際の移行が依頼されるまで保留します。

このファイルは簡潔かつ公開可能な内容に保ちます。現在の詳細なアーキテクチャはdocs/、タスクコンテキストはwork/、一時的なコンテキストはmemory/に保存します。
