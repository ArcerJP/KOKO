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

| 検査                        | 状態       | 現在の実装または未導入理由                                                                             |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| 依存関係の再現可能なinstall | 導入済み   | npm workspacesを`npm ci`とlockfileで再現。                                                             |
| format／対応形式の構文解析  | 導入済み   | `.github/workflows/format-check.yml`の`Prettier` jobが`npm run format:check`を実行。                   |
| Markdown Linter／静的解析   | 導入済み   | `.github/workflows/markdown-lint.yml`の`Markdown Lint` jobが`npm run lint:md`を実行。                  |
| OpenAPIと生成物一致         | CI定義済み | `Contract Schema`：Redocly lint、生成型とエラー表の一致。                                              |
| ユニットテスト              | CI定義済み | `Contract Tests`：Node test runnerで状態・判定・キー・エラー・権限・トークン等を検証。                 |
| SQL統合テスト               | CI定義済み | 同jobでPGliteへmigrationを実適用し、14テーブル・制約・grants/RLS・イベント境界を検証。                 |
| JS/TS Linter                | CI定義済み | `TypeScript Lint`：契約側ESLint 10とWeb側ESLint 9／Next.js公式設定。生成型は生成一致とtscで検査。      |
| 型チェック                  | CI定義済み | `Type Check`と`API Type Check`：契約build、Web/APIのstrict tsc、Wrangler生成型一致。                   |
| 契約package build           | CI定義済み | `Contract Build`：共用ESMと型宣言をdistへ出力。Web/API production buildの代替ではない。                |
| Web単体・HTTP／メディア統合 | CI定義済み | `Web Tests`：Vitest、MSW、合成メディアの実トリムとpacket照合、Worker境界。                             |
| Web production build        | CI定義済み | `Web Build`：共有契約build後のNext.js production build。                                               |
| Webブラウザ操作             | CI定義済み | `Web Browser Tests`：production serverを使うPlaywright Chromium。写真・動画・異常入力・モバイル幅。    |
| API実行環境テスト           | CI定義済み | `API Tests`：Cloudflare公式Vitest pluginとローカルMiniflareでHTTP境界・R2 binding分離を検証。          |
| API production build        | CI定義済み | `API Build`：実deployと同じWrangler設定を`wrangler deploy --dry-run`でbundle化し、外部へuploadしない。 |
| Docker image build          | 未導入     | Cloud Runを採用済みだが画像decoderのスパイク前でDockerfileなし。B1-7で実装と同時に追加。               |

契約向け5jobは`.github/workflows/contract-check.yml`に定義しています。workflowの存在とGitHub上の実行成功は別です。PGliteはPostgreSQLエンジンでSQLを実行しますが、Supabase Auth、実OAuth、クラウド通信、認証付きメディア配信を検証していません。これらは第1〜第3要件の別の統合/実機試験です。

Markdownlintは`.gitignore`を尊重して追跡対象相当のMarkdownを検査します。日本語文書と表の可読性をPrettierへ委ねるため、行長の`MD013`を無効化します。また、タスクテンプレートのfront matterにある`title`は文書見出しではなくmetadataとして扱うため、`MD025`ではfront matterを見出しとして数えません。それ以外は既定ruleを使用します。

## Web検査とLintの保守

Web向け3jobは`.github/workflows/web-check.yml`に定義します。秘密やクラウド課金なしで実行でき、実機のカメラ・実OAuth・R2通信をモック成功で代替しません。詳細は[撮影検証](product/stage-one-capture.md)を参照してください。既存の契約job名は維持し、`Contract Tests`は`test:contract`、`Contract Build`は`build:contract`へ明示的に限定します。

API向け3jobは`.github/workflows/api-check.yml`に定義します。`API Type Check`、`API Tests`、`API Build`は秘密情報やCloudflareログインなしで実行します。テストのR2はローカル保存であり、開発用実バケットとの通信成功を示しません。`API Build`もdry-runであり、Cloudflareへのdeploy成功とは区別します。

### 開発用Lintの互換性と移行課題

WebだけESLint 9.39.5を使用する構成はユーザー承認済みです。Next.js公式設定が使うimport／React／アクセシビリティのプラグインはESLint 10をpeer範囲に含めないため、契約側のESLint 10を変更せず分離します。`--force`や`--legacy-peer-deps`で互換性違反を無視しません。lockfileの再現と`npm ls --all`を検査します。

ESLint 9は2026-08-06にEOLとなっています。[公式サポート表](https://eslint.org/version-support/)で判明したこの追加リスクを含め、一時利用と移行方針は2026-09-23にiijimaが承認しました。開発・CI専用で本番の実行依存ではありませんが、既知の脆弱性0件を将来の安全保証にはしません。公式プラグインの10対応時に移行し、lint・型・全試験・buildを再検証します。

`package.json`のscoped overridesでNext.js配下を9系へ固定し、9／10の両方に対応するTypeScript ESLintとeslint-utilsの共有helperは既存のroot版を参照します。npmのhoistによるpeer競合を避けるための設定です。バージョン更新時は、overrideも含めて`npm ci --strict-peer-deps`と`npm ls --all`で再検証してください。

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
npm.cmd run contract:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd exec --workspace @koko/web -- playwright install chromium
npm.cmd run test:e2e
```

## 必須status check

workflowを追加しただけではmergeを技術的にブロックできません。新しいjobがGitHub上で一度成功した後、repository管理者がmainのRulesetまたはBranch protection ruleへ必須status checkとして登録します。

`Prettier`、`Markdown Lint`、`Contract Schema`、`TypeScript Lint`、`Type Check`、`Contract Tests`、`Contract Build`、`Web Tests`、`Web Build`、`Web Browser Tests`はmainで必須化済みです。今回追加する`API Type Check`、`API Tests`、`API Build`はGitHub上で一度成功した後、管理者が必須status checkへ追加してください。既存checkを外しません。このタスクではRulesetを変更しません。

## 人間が決定する項目

現在の構成選択は[ADR-0001](decisions/ADR-0001-product-baseline.md)、残る判断は[第0日](product/day-zero.md)で管理します。次の領域は第0日に選定したものを維持し、今後の未決・追加・変更事項はプロダクト設計へ影響するため推測で決めません。

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
