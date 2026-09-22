# 信頼できる情報源

## 原則

KOKOでは、すべての記録を同じ正本性で扱いません。適切な情報源は、回答対象の問いによって異なります。

| 問い                                              | 正本                                         | 正本ではない補助資料                                   |
| ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| システムは現在何をするか                          | 実際のソースコードと観測したランタイム動作   | 計画、引き渡し、古い文書                               |
| なぜそのアーキテクチャを選択したか                | docs/decisions/の受理済みADR                 | MEMORY.mdの要約、タスク上の議論                        |
| 現在の正式なアーキテクチャまたは仕様は何か        | 現在のdocs/                                  | wikiの統合知識、実装計画                               |
| 原資料には何と記載されていたか                    | knowledge/raw/または引用した正式な外部資料   | knowledge/wiki/の要約                                  |
| どのような再利用可能な結論が導出されたか          | 証拠に基づくknowledge/wiki/の正規ページ      | タスク固有の調査                                       |
| どのプロジェクト継続情報を残すべきか              | MEMORY.md                                    | 一時メモリの記録                                       |
| 実行中タスクの証拠と意図は何か                    | `work/notebook/<task-id>/`                   | チャット上の記憶                                       |
| 人間のレビューへ何を引き渡したか                  | `work/outbox/<task-id>/`                     | 併存してはならない実行中notebookのコピー               |
| 過去のタスク記録は何か                            | `work/archive/YYYY/<task-id>/`               | 以前の状態の配置場所                                   |
| Codexはどのように振る舞うべきか                   | 適用されるAGENTS.mdと選択されたSkill         | READMEまたは通常の文書                                 |
| Gitのbranch、commit、Pull Requestをどう運用するか | .agents/skills/git-workflow/SKILL.md         | README、PRテンプレート                                 |
| CIで何を自動検査し、いつ検査を追加するか          | .github/workflows/とdocs/ci.md               | README、Pull Request本文                               |
| ファイルをどの形式で整形するか                    | docs/formatting.mdとリポジトリ直下の整形設定 | knowledge/raw/FormatterSetting.pdf、エディター個人設定 |

## 競合時のルール

プロダクトでは、要求は[要件](../product/requirements.md)、実装順序は[開発計画](../product/development-plan.md)、採用構成は[プロダクト構成](product-architecture.md)、承認状況は[第0日](../product/day-zero.md)を参照します。API/状態/キー/エラーの正本は[共有契約](../../packages/contract/README.md)、DBはapps/apiのmigration、トークンはapps/webのCSSです。生成型・エラー表は派生物であり、手で編集しません。

nativeへの設計境界は[native対応準備](native-readiness.md)、予算判断と動画短縮の方針は[費用方針](../product/cost-policy.md)へ分離します。費用を比較する反復手順は[cost-review Skill](../../.agents/skills/cost-review/SKILL.md)、現在のサービス料金の根拠は各社公式資料です。Skillや過去の試算を最新料金の正本にしません。

原資料の記述と、後日のユーザー決定を区別します。現在の仕様にはAccepted ADRを適用し、元資料の内容を問う場合は変更していないknowledge/rawを参照します。契約の存在から機能実装・クラウド適用・人間の合意を推定しません。

1. 競合する情報源を暗黙に調整しません。
2. 問いと、その正本区分を特定します。
3. 日付、バージョン、出典、実装状態、および決定が提案済み、受理済み、置換済み、廃止済みのいずれかを確認します。
4. 存在する動作については現在観測した動作を優先し、受理済み仕様に違反する場合は記録します。
5. 証拠に関する主張では、導出済みwiki内容より原証拠を優先します。
6. 古くなった非正本のコピーを修正するかリンクへ置き換え、競合する完全な複製を残しません。
7. 範囲、安全性、互換性、アーキテクチャを変える重大な曖昧さは、人間へ判断を求めます。

## 重複の境界

共同開発者の環境再現は[導入手順](../collaborator-setup.md)、非公開資料の共有先・対象・更新運用は[非公開共有](../private-sharing.md)を正本とします。PublicのKOKOとPrivateのKOKO-privateのGit状態を混同せず、双方のcommitと内容hashを照合します。Codexの安全な反映手順は[private-context-sharing Skill](../../.agents/skills/private-context-sharing/SKILL.md)に置きます。

第1の撮影・トリム受入手順は[stage-one-capture](../product/stage-one-capture.md)、クラウドのアカウント・権限・課金準備は[cloud-setup](../product/cloud-setup.md)が正本です。自動テストは実装を検証するもので、実機や実クラウドの受入記録を代替しません。個別の測定JSONは非公開のタスク証拠として扱います。

- MEMORY.mdからADRへリンクできますが、その内容を複製してはいけません。
- README.mdでアーキテクチャを要約できますが、正式文書へリンクしなければなりません。
- 計画は意図した変更を説明するもので、実装後に現在の仕様とはなりません。
- 調査はタスク固有です。再利用可能な統合知識だけをwikiへ昇格します。
- wikiページは証拠を引用し、原資料や規範的文書を置き換えません。
