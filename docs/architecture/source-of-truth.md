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
| CIで何を自動検査し、配備をいつ許可するか          | .github/の実装とdocs/ci.md                   | README、Pull Request本文                               |
| ファイルをどの形式で整形するか                    | docs/formatting.mdとリポジトリ直下の整形設定 | knowledge/raw/FormatterSetting.pdf、エディター個人設定 |

## 競合時のルール

Web→開発Workerのサービス認証は[ADR-0005](../decisions/ADR-0005-web-access-service-auth.md)が採用理由、[Web README](../../apps/web/README.md#accessサービス認証)が設定/本人ゲート、[クラウド準備](../product/cloud-setup.md)が実適用の証拠です。ローカル実装からtoken発行・権限付与・接続成功を推定しません。

2026-10-03採択の自律進行・条件付き継続承認・保護操作の区分は[AGENTS.md](../../AGENTS.md#作業進行と承認境界)が正本です。USER.mdは本人の希望と採択経緯、TOOLS.mdはツール別条件、各Skillは実行手順を扱います。以前の一般的な「必ず質問」「技術変更は承認待ち」よりこの区分を優先し、過去の承認履歴は当時の証拠として保持します。

CI/CDの実行定義は`.github/workflows/`、配備直前のガードは`.github/scripts/`、その秘密なしの回帰試験は`.github/tests/`へ分離します。外部環境の適用済み状態は[クラウド準備](../product/cloud-setup.md)に記録し、ローカルworkflowの存在から実配備成功を推定しません。KOKOの配備再開・診断・限定変更・受入の順序は[api-deployment Skill](../../.agents/skills/api-deployment/SKILL.md)を正本とし、実行条件や現在のクラウド状態をSkillへ複製しません。

プロダクトでは、要求は[要件](../product/requirements.md)、実装順序は[開発計画](../product/development-plan.md)、採用構成は[プロダクト構成](product-architecture.md)、承認状況は[第0日](../product/day-zero.md)を参照します。API/状態/キー/エラーの正本は[共有契約](../../packages/contract/README.md)、DBはapps/apiのmigration、トークンはapps/webのCSSです。生成型・エラー表は派生物であり、手で編集しません。

画面に配布する採択済みの利用規約/プライバシー本文は[approved-terms.ts](../../apps/web/src/api/approved-terms.ts)で一元管理し、現在は未採択のため空です。登録条件・版管理・未一致時の拒否は[Web README](../../apps/web/README.md#現行規約の明示同意画面本文未採択既定無効)を参照してください。本文の存在や試験用文章から、人間の採択・DB現行版の変更・実同意受付完了を推定しません。

nativeへの設計境界は[native対応準備](native-readiness.md)、予算判断と動画短縮の方針は[費用方針](../product/cost-policy.md)へ分離します。費用を比較する反復手順は[cost-review Skill](../../.agents/skills/cost-review/SKILL.md)、現在のサービス料金の根拠は各社公式資料です。Skillや過去の試算を最新料金の正本にしません。

原資料の記述と、後日のユーザー決定を区別します。現在の仕様にはAccepted ADRを適用し、元資料の内容を問う場合は変更していないknowledge/rawを参照します。契約の存在から機能実装・クラウド適用・人間の合意を推定しません。

1. 競合する情報源を暗黙に調整しません。
2. 問いと、その正本区分を特定します。
3. 日付、バージョン、出典、実装状態、および決定が提案済み、受理済み、置換済み、廃止済みのいずれかを確認します。
4. 存在する動作については現在観測した動作を優先し、受理済み仕様に違反する場合は記録します。
5. 証拠に関する主張では、導出済みwiki内容より原証拠を優先します。
6. 古くなった非正本のコピーを修正するかリンクへ置き換え、競合する完全な複製を残しません。
7. 技術的な不確実性は調査・比較・検証して判断と理由を記録します。依頼目的内の設計/互換性への影響だけで一律に許可待ちにせず、保護操作、目的外への拡大、本人しか決められない重要事項は人間へ渡します。

## 重複の境界

Cloud Runへの呼出元認証は[ADR-0007](../decisions/ADR-0007-private-image-service.md)の方式選定、[認証準備](../product/cloud-run-auth-setup.md)の本人手順、cloud-setupの実適用記録を区別します。Vercel OIDC/WIFを選定したことは、中継コードの実装・プール有効化・IAM授権・実接続の成功を意味しません。

第1〜第3の機能は実装・模擬試験・実クラウド受入を区別します。APIのQueue/Stream/認証配信/運営outboxは`apps/api`、画面と専用中継は`apps/web`、AI前処理/合議/記録は`apps/image`に保持します。設定と安全境界は各app READMEへ集約し、private Realtimeの変化通知やHTTP成功をDBの認可・公開・job完了の正本として扱いません。外部API/端末の測定や本人操作を、テストfixture・ログイン済み画面から推定しません。

画像変換コア/CLI/認証HTTPは`apps/image/src`、その現在の仕様・安全境界・未受入は[画像README](../../apps/image/README.md)、実コンテナー定義は`apps/image/Dockerfile`、CIは`.github/workflows/image-check.yml`です。HTTPの設計判断は[ADR-0007](../decisions/ADR-0007-private-image-service.md)へ分離します。合成HEIC fixtureや合成Google署名を実機・実IAM受入の証拠としません。原本や生成物の実データは公開ソースへ含めません。

端末内送信キューの実装は`apps/web/src/media/upload-queue*`、採用理由は[ADR-0006](../decisions/ADR-0006-durable-browser-upload-queue.md)、設定・保存境界・未受入は[Web README](../../apps/web/README.md#端末内送信キューと投稿画面f1-5f2-1既定無効)です。端末受付、サーバー受付、公開を区別し、ブラウザ試験を実機・実クラウド完了の証拠にしません。

共同開発者の環境再現は[導入手順](../collaborator-setup.md)、非公開資料の共有先・対象・更新運用は[非公開共有](../private-sharing.md)を正本とします。PublicのKOKOとPrivateのKOKO-privateのGit状態を混同せず、双方のcommitと内容hashを照合します。Codexの安全な反映手順は[private-context-sharing Skill](../../.agents/skills/private-context-sharing/SKILL.md)に置きます。

第1の撮影・トリム受入手順は[stage-one-capture](../product/stage-one-capture.md)、クラウドのアカウント・権限・課金準備は[cloud-setup](../product/cloud-setup.md)が正本です。自動テストは実装を検証するもので、実機や実クラウドの受入記録を代替しません。個別の測定JSONは非公開のタスク証拠として扱います。

- MEMORY.mdからADRへリンクできますが、その内容を複製してはいけません。
- README.mdでアーキテクチャを要約できますが、正式文書へリンクしなければなりません。
- 計画は意図した変更を説明するもので、実装後に現在の仕様とはなりません。
- 調査はタスク固有です。再利用可能な統合知識だけをwikiへ昇格します。
- wikiページは証拠を引用し、原資料や規範的文書を置き換えません。
