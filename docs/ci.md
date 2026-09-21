# 継続的インテグレーション規約

## 目的

Pull Requestの作成・更新時に再現可能な自動検証を行い、既存動作の破壊、構文・書式の不整合、型エラー、リリース不能なbuildをmerge前に検出します。

## 正本

- 実際にGitHub上で実行する内容：`.github/workflows/`。
- CIの適用範囲、未導入項目、追加条件：この文書。
- ローカルで実行する個別command：採用した言語・framework・package managerの設定ファイル。

文書に検査が記載されていてもworkflowに実装されていなければ、自動化済みとは扱いません。workflowが存在しても空のtestやskipだけで終了する場合は、検証済みとは扱いません。

## 実行契機と権限

- `pull_request`でPull Requestの作成、commit追加による更新、再open時に実行します。
- merge queueを使用する場合に備え、`merge_group`でも実行します。
- workflowの権限は検査に必要な最小限とし、現在は`contents: read`だけを許可します。
- 外部からのPull Requestで秘密情報を渡さずに実行できる検査を基本とします。

## 現在の導入状態

| 検査                               | 状態     | 現在の実装または未導入理由                                                                      |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 依存関係の再現可能なinstall        | 導入済み | `npm ci`で`package-lock.json`どおりにリポジトリ品質管理用の依存関係を導入。                     |
| format／対応形式の構文解析         | 導入済み | `.github/workflows/format-check.yml`の`Prettier` jobが`npm run format:check`を実行。            |
| Markdown Linter／静的解析          | 導入済み | `.github/workflows/markdown-lint.yml`の`Markdown Lint` jobが`npm run lint:md`を実行。           |
| ユニットテスト                     | 未導入   | プロダクトソース、test runner、test対象の機能がまだ存在しない。                                 |
| 統合テスト                         | 未導入   | 統合対象のmodule、API、database、外部serviceがまだ存在しない。                                  |
| プロダクト言語固有Linter／静的解析 | 未導入   | プロダクトの言語とframeworkが未決定。PrettierやMarkdownlintはESLint、flake8などの代替ではない。 |
| 型チェック                         | 未導入   | TypeScriptなどの型付き言語と型設定が未決定。                                                    |
| production build                   | 未導入   | application、build command、成果物、deployment先が未決定。                                      |
| Docker image build                 | 未導入   | container化とDockerfileが未決定。                                                               |

現時点のCIはformat検査とMarkdown文書の静的解析です。未導入項目は成功した検査ではなく、検査対象と実行方法がまだ存在しない項目です。

Markdownlintは`.gitignore`を尊重して追跡対象相当のMarkdownを検査します。日本語文書と表の可読性をPrettierへ委ねるため、行長の`MD013`を無効化します。また、タスクテンプレートのfront matterにある`title`は文書見出しではなくmetadataとして扱うため、`MD025`ではfront matterを見出しとして数えません。それ以外は既定ruleを使用します。

## 禁止する見かけ上の成功

- assertionを持たない空のtestや、常に終了code 0を返す仮commandを追加しません。
- 必須検査に`--if-present`を使用し、commandが存在しない状態を成功扱いにしません。
- 必須jobを条件付きでskipし、実際には検査していないcommitをmerge可能にしません。
- format検査を、Linter、型チェック、ユニットテスト、buildの代替として報告しません。
- product buildが存在しない状態で、品質管理用`package.json`のinstall成功をproduction build成功と表現しません。

## プロダクト実装時の導入ゲート

各言語、framework、service、deployment方式を初めて導入するPull Requestでは、該当する検査対象と同時に次を追加します。

1. ローカルでもCIでも同一結果になる、固定された実行command。
2. 正常系と重要な失敗系を検証するユニットテスト。
3. module、API、database、外部serviceなど境界が生じる場合の統合テスト。
4. 採用言語に対応するLinter／静的解析。
5. 型システムを採用する場合の型チェック。
6. deploymentへ使用するものと同一設定のproduction build。
7. containerを採用する場合だけ、実際のDockerfileを使用するimage build。
8. 各検査を独立して識別できる、安定したGitHub Actions job名。

実装だけを先行させ、後続作業としてCIを残しません。検査を導入できない重大な理由がある場合は、理由、影響、導入条件をPull Requestへ明記し、人間の承認を得ます。

## Pull Request前の確認

1. この文書の「導入済み」に該当する検査をすべてローカルで実行します。
2. Pull Request本文に、実行したcommandと結果を記録します。
3. 未導入または適用外の項目は成功と記載せず、理由を記録します。
4. GitHub Actionsが最新commitに対して成功したことを確認します。

現在ローカルで必須のCI相当commandは次のとおりです。

```powershell
npm.cmd run format:check
npm.cmd run lint:md
```

## 必須status check

workflowを追加しただけではmergeを技術的にブロックできません。新しいjobがGitHub上で一度成功した後、repository管理者がmainのRulesetまたはBranch protection ruleへ必須status checkとして登録します。

現在登録対象となるcheckは、`Format Check` workflowの`Prettier` jobと、`Markdown Lint` workflowの`Markdown Lint` jobです。将来test、プロダクト言語固有lint、typecheck、buildのjobを追加した場合も、それぞれを必須status checkへ追加します。

## 人間が決定する項目

次の選択はプロダクト設計へ影響するため、推測で決めません。

- プロダクトの言語、framework、package manager、対応runtime version。
- unit／integration test frameworkと、integration testで使用するdatabaseや外部service。
- Linter、formatterとの責務分担、型チェックtoolとstrictness。
- production build command、成果物、deployment先。
- Dockerを採用するか、およびimageの実行環境。

## 参照資料

- GitHub公式：[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- GitHub公式：[Building and testing your code](https://docs.github.com/en/actions/tutorials/build-and-test-code)
- GitHub公式：[Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)
- GitHub公式：[Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- Markdownlint CLI2公式：[DavidAnson/markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2)
