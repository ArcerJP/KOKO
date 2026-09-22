# 非公開資料の継続共有

更新日：2026-09-23。共同開発者への導入全体は[導入手順](collaborator-setup.md)を参照してください。

## 方針と現在の状態

2026-09-23に、iijimaがOrganization `ArcerJP`のPrivateリポジトリ`KOKO-private`を作成し、現在・今後のKOKO原資料、タスク記録、プロジェクト用メモをメインメンバーへ継続共有する方針を承認しました。公開KOKOの可視性とignore設定は維持します。

共有先はPrivateで作成済みです。初回だけ承認された例外として、資料を含まない管理用README・安全設定の1commitでmainを初期化しました。資料は別の作業ブランチ・PRで共有します。ローカル保存先は公開KOKOの隣のKOKO-privateです。

メンバー別の招待・権限、初期資料PR、対応する公開commit、資料の照合結果は、非公開側READMEとPRへ記録します。PRの作成・merge・相手PCへの取込みはそれぞれ別の確認事項であり、共有先を作っただけでは導入完了ではありません。

2026-09-23時点で非公開側のbranch protection／Rulesetは未設定です。GitHubの設定画面には、OrganizationをGitHub Teamへ変更するまでPrivateのRulesetは強制されない旨が表示されました。したがって、現状のPRルールは人による運用であり、直接pushの技術的遮断を保証しません。有料化は別途判断し、契約や保護設定を完了したと推定しません。[公式のRuleset利用条件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)

## 公開と非公開を分ける

```text
同じ親フォルダー/
├── KOKO/                  開発する場所。originはPublicのArcerJP/KOKO
│   ├── apps/・packages/   公開ソース
│   ├── docs/              公開可能な正式文書
│   ├── knowledge/raw/    ローカル原資料（公開例外以外はignore）
│   ├── work/              ローカルのタスク状態（動的内容はignore）
│   └── memory/            プロジェクト用メモ（動的内容はignore）
└── KOKO-private/          非公開の受渡し場所。ここでは製品開発しない
    ├── README.md          メンバー・共有時点・対応する公開commit
    └── context/           KOKO相対パスを保った、確認済み資料の共有コピー
        ├── knowledge/raw/
        ├── work/
        └── memory/
```

`context/`は共有時点の記録です。KOKO-private内のタスクを別の実行中タスクとして開始しません。各PCのKOKOでは、[作業ライフサイクル](../work/WORKFLOW.md)の「1タスク1状態」を維持します。ソースや生成物は非公開側へ複製しません。

共有の照合単位は、公開KOKOのcommit SHA、非公開KOKO-privateのcommit SHA、資料の相対パスとSHA-256です。両リポジトリの`main`が常に同じ時点を指すとは仮定しません。

## 共有するもの・しないもの

| 区分                                                                      | 扱い                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 原資料、タスクの依頼・調査・計画・引き渡し、プロジェクト用メモ            | 現在と今後の共有対象。内容確認後、元の相対パスでPrivateへ反映                                     |
| 公開Gitで追跡するREADME、FormatterSetting.pdf、正式docs、ソース           | 公開cloneから取得。非公開側で二重管理しない                                                       |
| node_modules、build、ブラウザ本体、キャッシュ、仮想環境、検証用ランタイム | 各PCで再構築。work内にあっても資料として共有しない                                                |
| APIキー、パスワード、秘密鍵、Cookie、認証キャッシュ、個人Codex履歴        | Privateにも含めない。秘密は本人別の権限と適切な秘密管理で扱う                                     |
| 第三者の個人情報や共有制限を含む資料                                      | メインメンバーであっても共有権限を確認。判断できなければ送信を保留                                |
| 大容量の写真・動画など                                                    | 自動でGitへ追加しない。容量・権利を確認し、別の非公開ストレージが必要なら費用・運用を比較して相談 |

フォルダー単位の無条件コピー、`git add .`や`git add -f`による機械的な追加、リポジトリ全体のZIP共有は使いません。Privateはアクセス制御であり、秘密情報を保存してよいという意味ではありません。取得済みのコピーは、後からGitHub権限を取り消しても回収できません。

## 管理者の初回設定

1. `ArcerJP/KOKO-private`を**Private**で作成します。Public／Internalへ変更しません。既存の同名リポジトリがある場合は、所有者・可視性・内容を確認してから使います。
2. Organizationの継承権限、既存チーム、GitHub Appsも含め、想定メンバー以外へ資料が見えないか確認します。Organization ownerは管理権限を持つため、「招待した人以外は誰も見られない」とは断定しません。
3. 本人確認したメンバーへ開発に必要な`Write`を付与し、本人が招待を承諾します。`Admin`や所有者のログイン情報は渡しません。[GitHub公式の役割](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
4. 非公開側でもmainへの通常の直接pushを避け、作業ブランチ・PRレビューを使います。保護ルールを設定できるかは契約・権限を確認し、設定していないものを強制済みと扱いません。有料プランへの変更は別途承認を得ます。
5. 公開KOKOへ非公開資料を戻すGitHub Actionsや、秘密を使った自動ミラーは作りません。非公開側のPagesや外部公開も有効化しません。

## 初回の取得

まず[公開KOKOの導入](collaborator-setup.md)を完了し、非公開リポジトリの招待を承諾します。同じ親フォルダーで実行します。既存の保存先を上書きしません。

```powershell
git clone https://github.com/ArcerJP/KOKO-private.git KOKO-private
git -C KOKO-private remote -v
git -C KOKO-private status --short
git -C KOKO-private rev-parse HEAD
```

招待済みでも`Repository not found`になる場合は、HTTPS認証のアカウントとOrganizationの認証要件を確認します。別人のトークンを借りません。

非公開側のREADMEで受渡し地点を確認します。merge前の資料を受け取る場合だけ、指定された作業ブランチとcommitへ切り替えます。権限のない人へPR本文・差分・ファイル一覧を貼り付けないでください。

### KOKOへ資料を取り込む

非公開cloneだけでは、KOKO内の`knowledge/raw`や`work`は自動で更新されません。次の順で確認して反映します。

1. `context/`の対象ファイルを一覧化し、公開Gitの追跡ファイルではなく、第3節の共有対象だけであることを確認します。シンボリックリンク・junction・不明な実行ファイルがあれば取り込みを止めます。
2. KOKO内の同じ相対パスと比較します。存在しなければ新規追加、hash一致なら操作不要、異なれば**上書き前に**両方の変更を確認します。
3. 必要な親フォルダーを作り、対象ファイルだけを`Copy-Item -LiteralPath`などでコピーします。原資料を整形・文字コード変換しません。
4. タスクがnotebook→outbox等へ移っている場合は、古い場所を残して複製せず、未共有の変更を保全してから同じタスクを移動します。判断できなければ担当者へ確認します。`/MIR`による一括削除は使いません。
5. `Get-FileHash -Algorithm SHA256`でコピー元・先の一致を確認します。公開KOKOの`git status --short`へ非公開資料が出ていないか、`git check-ignore -v -- <対象の相対パス>`で除外を確認します。

Codexへ依頼する場合は、KOKOを開き、次のように伝えます。ローカル保存先が異なる場合は実際の場所も伝えてください。

> private-context-sharing Skillを使い、KOKO-privateで承認・mergeされた非公開資料をKOKOへ取り込んでください。先に差分と衝突を確認し、未共有の変更を上書きしないでください。公開Gitへは追加しないでください。

## 日常の共有・更新

自動送信や定期同期ではなく、**資料追加・変更、タスクの引き渡し時に行う、確認付きの共有**です。共有し忘れを防ぐため、引き渡しには非公開側の反映状況または未反映理由も記録します。

1. KOKO-privateの状態を確認し、未commitの他人の変更がないことを確かめます。mainへ戻って`git pull origin main`を行い、目的に合う作業ブランチを1つ作ります。
2. 前回共有後の相手側の更新を先に確認します。受取側の新しい変更を、古いKOKOのコピーで戻さないでください。
3. KOKOの原資料・タスク記録・メモから、今回の新規・更新・移動・削除候補を列挙します。新しい非公開資料も漏れなく候補に含めますが、生成物・秘密・第三者の制限を確認してから対象を確定します。
4. 対象だけを`KOKO-private/context/`へ元の相対パスで反映し、SHA-256で照合します。移動・削除は元と先の状態を確認して個別に扱い、他人の未共有資料を消しません。
5. 非公開側READMEへ、対応する公開commit、共有対象・除外理由、確認日を記録します。認証情報の値を記載しません。
6. **必ず非公開側のremoteとPrivate表示を確認してから**、対象パスを明示してstageし、差分をレビューします。1目的1commit、PR前の`git pull origin main`、PRタイトル等は[Gitワークフロー](../.agents/skills/git-workflow/SKILL.md)を適用します。
7. 許可された範囲で非公開ブランチをpushし、非公開PRを作ります。mergeはレビュー後に人間が行います。受取側はmerge後にpullし、前節の比較・取込みを行います。
8. merge後の作業ブランチを削除し、双方の取り込み完了／未完了を確認します。ローカルへのコピー、push、PR作成、merge、相手PCでの取込みは別の状態です。

Codexへの依頼例：

> private-context-sharing Skillで、今回変更したKOKOの非公開資料をすべて確認してください。秘密や生成物を除き、相手側の更新と衝突がなければKOKO-privateへ反映し、目的別commitと非公開PRを作成してください。共有対象・除外・衝突を報告してください。

同じ資料を複数人が編集する場合は、着手前に担当を確認し、最新の非公開mainを取得します。機械的な最終更新日時の比較や「新しい方で上書き」では変更を統合しません。

## 共有の完了条件

- Private可視性と対象メンバーの権限を確認した。
- 対象・除外・未判断の資料を区別し、秘密や実行環境を含めていない。
- 元資料と非公開共有コピーの相対パス・内容hashが一致する。
- 公開KOKOのindex・commit・PRへ非公開資料が混入していない。
- 非公開PRの状態、対応する公開commit、受取側での取得状況を記録した。

人間向けの運用と共有境界はこの文書、Codexの作業手順は[private-context-sharing Skill](../.agents/skills/private-context-sharing/SKILL.md)、原資料の取扱いは[知識スキーマ](../knowledge/SCHEMA.md)を正本とします。
