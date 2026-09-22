# 共同開発者の導入手順（Windows）

更新日：2026-09-23。対象はWindows／PowerShellです。管理者権限のターミナルは通常不要です。

## 1. 「同じ状態」にする範囲

目標は、同じGitコミット・固定依存関係・共通ルールを取得し、同じ検査と開発画面を動かせる状態です。別PCのディスク全体をバイト単位で一致させることではありません。

GitHubのZIPは特定時点の追跡ファイルを入手できますが、Git履歴・remote・ローカル設定・依存関係・非公開資料は復元しません。共同開発にはHTTPSの`git clone`を使います。[GitHub公式のclone手順](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository)

| 対象                                                                 | 共同開発者への導入方法             | 一致の確認                                |
| -------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| ソース、docs、AGENTS.md、リポジトリSkills、整形・CI設定、合成fixture | 同じコミットをclone／checkout      | commit SHA・tree SHA・作業差分            |
| npm依存関係                                                          | 同じNode/npmとlockfileから`npm ci` | lockfileのSHA-256、`npm ls --all`、全検査 |
| build、型生成、Playwrightのブラウザ、Git hook                        | 各PCで再生成・導入                 | build・ブラウザ試験・hook設定             |
| 非公開の原資料・タスク記録・プロジェクト用メモ                       | 権限を限定した別の共有先から取得   | 共有対象リストと個別ファイルのSHA-256     |
| Gitの本人情報、Codexログイン、クラウド権限                           | 本人のアカウントで設定・招待       | 本人がアクセスを確認                      |
| APIキー、パスワード、個人のCodex履歴・認証キャッシュ                 | ディレクトリ共有の対象外           | コピー・commitしない                      |

OS／CPU、インストール先、キャッシュ、更新日時、ブラウザの保存領域、生成物の内部IDなどは一致保証の対象外です。CIもNode.js 24系を使いますが、OSとNode/npmのパッチ版まで固定した完全同一環境ではありません。

## 2. iijima側で先に用意するもの

1. **公開コードの受渡し地点**：今回の実装を含むPRをmergeしてから、その`main`の完全なcommit SHAを知らせます。merge前に確認する場合だけ、push済みの作業ブランチ名とそのcommit SHAを別途指定します。未commit・未pushの変更はcloneでは渡りません。
2. **GitHub権限**：共同開発者本人のGitHubアカウントを確認し、ArcerJP/KOKOへ開発に必要な権限で招待します。閲覧用のcloneはPublicなので可能ですが、共同開発者本人としてのpushには権限と本人認証が必要です。管理者権限やアカウントの共用は不要です。
3. **非公開資料の共有先と閲覧権限**：第7節の安全境界を確認して別途用意します。PublicのKOKOへ追加しません。
4. **実行環境の記録**：下の出力を渡します。秘密の値や`.git/config`全体、環境変数一覧は送らないでください。

KOKOルートで実行します。`git status`に差分があれば、その未確定状態を「同一コミットで渡せる」と扱いません。

```powershell
git status --short
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256
node --version
npm.cmd --version
git --version
node -p "process.platform + '/' + process.arch"
```

本手順の作成時に確認した環境はNode.js **24.16.0**、npm **11.13.0**、Git for Windows **2.54.0.windows.1**、`win32/x64`です。これは検証時点の記録であり、将来も最新版・安全性が保証されるという意味ではありません。導入時は受渡し元とNode/npmを揃え、更新は別の変更として検証します。

## 3. 共同開発者のPCを準備する

1. [Git for Windows公式](https://git-scm.com/downloads/win)からGitを導入します。既にある場合は先に`git --version`で確認します。
2. [Node.js公式](https://nodejs.org/en/download)で受渡し元と合意したNode.js 24系の版を導入します。npmも`npm.cmd --version`で確認します。既存の別プロジェクトの環境を上書きせず、版が違う場合は導入方法を相談してください。
3. インストール後、PowerShellを開き直します。Windowsでは`npm.ps1`の実行ポリシー回避のためにOS設定を緩めず、以下の`npm.cmd`を使います。
4. エディターは任意です。VS Code系を使う場合は[フォーマット規約](formatting.md)に従って推奨拡張機能を導入します。

Node/npmの版は`package-lock.json`だけでは導入されません。現状はDocker、クラウドCLI、DBサーバー、システム版ffmpegの導入は不要です。SQL統合試験はnpm依存のPGliteで実行します。

## 4. HTTPSでcloneし、受渡し元のコミットを確認する

各コマンドは1つずつ実行し、エラーが出た時点で止めてください。以下の`C:\dev`は一例で、本人が書き込める任意の親フォルダーに置換できます。同期ドライブ配下を避けると、依存関係やGitロックの同期競合を減らせます。既存のKOKOは削除・上書きしません。

```powershell
New-Item -ItemType Directory -Path 'C:\dev' -Force
Set-Location -LiteralPath 'C:\dev'
Test-Path -LiteralPath '.\KOKO'
```

最後が`False`のときだけ、続けます。`True`ならそのフォルダーを確認し、新しい保存先を選びます。

```powershell
git clone https://github.com/ArcerJP/KOKO.git KOKO
Set-Location -LiteralPath '.\KOKO'
git remote -v
git status --short
git rev-parse HEAD
```

`origin`は`https://github.com/ArcerJP/KOKO.git`、作業差分は空であることを確認します。ZIPの展開後に`git init`する方法や、他人の`.git`フォルダーのコピーは使いません。

### 同じ時点を厳密に照合する

次の入力にはiijimaから受け取った**完全な40桁のcommit SHA**を使います。`main`は進むため、ブランチ名だけでは同じ時点を保証できません。

```powershell
$kokoRevision = Read-Host '受け取った40桁のcommit SHA'
if ($kokoRevision -notmatch '^[0-9a-fA-F]{40}$') { throw 'SHAを確認してください' }
git fetch origin
git cat-file -t $kokoRevision
git switch --detach $kokoRevision
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256
git status --short
```

`cat-file`の出力が`commit`であること、HEADとtree、lockfileのhashが受渡し元と一致すること、作業差分が空であることを確認します。見つからなければ、push済みか・SHAが正しいかを確認します。`detached HEAD`は比較のための一時状態です。この状態で開発commitを作らず、第9節で通常の作業ブランチへ進みます。SHA一致は同一性の確認であり、未知のコードの安全性を保証するものではありません。

## 5. 依存関係・整形・テスト用ブラウザを導入する

cloneしたKOKOルートで実行します。下の導入では、リポジトリと依存パッケージのinstallスクリプトが実行されます。信頼できる受渡しcommitであることを先に確認してください。

```powershell
node --version
npm.cmd --version
npm.cmd ci --include=dev --strict-peer-deps
npm.cmd ls --all
npm.cmd exec --workspace @koko/web -- playwright install chromium
git config --local --get core.hooksPath
git status --short
```

- `npm ci`はlockfileを変更せずに依存関係を導入します。既存の`node_modules`があれば再作成するため、起動中の開発サーバーを止めてから実行します。[npm公式](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- npm workspacesはルートでまとめて導入します。`apps/web`で別のlockfileを作ったり、他人の`node_modules`をコピーしたりしません。
- `npm ls --all`が終了コード0になることを確認します。Web側ESLint 9と契約側ESLint 10の分離は意図したものです。理由・EOLリスク・承認・移行方針は[CI規約](ci.md)が正本です。`--force`や`--legacy-peer-deps`で失敗を隠しません。
- `prepare`によってHuskyを導入し、`core.hooksPath`は`.husky/_`になります。通常の共同開発では`HUSKY=0`や`--ignore-scripts`を設定しません。既存の別hook設定がある場合は上書き前に相談します。
- Playwrightは依存版に対応する専用Chromiumを取得します。普段使うChromeをコピーする必要はありません。ブラウザのダウンロードは初回・Playwright更新時に必要です。[Playwright公式](https://playwright.dev/docs/browsers)
- `PLAYWRIGHT_BROWSERS_PATH`を独自指定している人は、installとテストに同じ設定を使います。通常は未設定の既定キャッシュで構いません。iijimaのブラウザ保存先をそのまま絶対パスで設定しないでください。

## 6. 同じ検査と画面を動かす

CI相当の検査は[CI規約](ci.md)が正本です。初回は以下を順に実行します。途中の失敗を無視して最後の成功だけを報告しません。

```powershell
npm.cmd run format:check
npm.cmd run lint:md
npm.cmd run contract:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
git diff --check
git status --short
```

`test:e2e`は直前のproduction buildを使い、テスト用サーバーを`127.0.0.1:3100`で起動・終了します。同ポートを別プロセスが使っていれば、持ち主を確認してから止めるか相談します。初回導入時に合成fixtureを再生成する必要はありません。

続いて開発画面を確認します。

```powershell
npm.cmd run dev
```

ブラウザで`http://127.0.0.1:3000`を開き、撮影・トリム検証画面が表示されることを確認します。終了は`Ctrl+C`です。素材の操作と実機確認は[撮影・トリム検証手順](product/stage-one-capture.md)へ進みます。

この段階では`.env`、クラウド鍵、Googleログインは不要です。自動テスト成功は、OAuth・R2・Stream・Cloud Run・実機の受入れ完了を意味しません。クラウドへ接続するときは[クラウド準備手順](product/cloud-setup.md)に従って本人を招待し、所有者の秘密情報をコピーして代用しません。

## 7. 非公開資料を継続して共有する

ユーザーは、共同開発者を継続的なメインメンバーとし、現在と今後の非公開資料も`ArcerJP/KOKO-private`（Private）で共有する方針を承認しました。公開KOKOとは別のリポジトリです。作成・招待・初期資料の反映状況と、初回取得・継続更新の手順は[非公開資料の継続共有](private-sharing.md)を正本とします。公開KOKOのcloneだけで非公開資料もそろったとは扱いません。

公開KOKOでは、以下を引き続きGit管理対象外にします。

- `knowledge/raw/`の原資料（明示的な公開例外を除く）。要件定義書・開発計画書の原本もZIPやcloneには含まれません。現在の公開仕様は`docs/product/`です。
- `work/inbox/`、`work/notebook/`、`work/outbox/`、`work/archive/`の動的なタスク記録。
- `memory/`のプロジェクト用一時メモなど、共有対象として確認したローカル資料。

秘密情報・認証キャッシュ・個人のCodex履歴は、この資料共有には含めません。Privateの保管先でも、資料内の第三者の個人情報・契約上の共有制限・秘密情報は確認が必要です。公開`.gitignore`を解除したり、`git add -f`で原資料をPublicへ載せたりしません。

資料の取扱いは[知識スキーマ](../knowledge/SCHEMA.md)、タスク記録は[作業ライフサイクル](../work/WORKFLOW.md)を維持します。共有対象を特定し、両PCの`Get-FileHash -Algorithm SHA256`で同一性を確認します。原資料は整形・改名・文字コード変換で書き換えません。既存ファイルに差がある場合は、自動上書きせず更新履歴を確認します。

## 8. Codexとエディターの設定を引き継ぐ

1. 利用するCodexアプリ／CLI／IDE拡張は本人のアカウントで導入・ログインします。Webのローカル検査だけならCodexの導入は必須ではありません。
2. cloneした**KOKOルート**をプロジェクトとして開きます。リポジトリの`AGENTS.md`と`.agents/skills/`はGitから取得済みです。ユーザー領域へ再コピーする必要はありません。[公式のAGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[公式のSkills](https://learn.chatgpt.com/docs/build-skills)
3. 新しいタスクで「適用中のAGENTS.mdとKOKOのSkillsを確認してください。まだ変更しないでください」と依頼し、Git・調査実装・タスク管理等の案内を確認します。下位文書の読込はルートのルーティングに従います。
4. 個人領域の`AGENTS.md`や設定、選択モデル、追加Skill・プラグイン・MCPはGit cloneでは揃いません。必要な連携だけ本人が導入・認証し、既存の個人設定との矛盾は相談します。プラグインがなくても、通常のローカル検査は上記のコマンドで実行できます。
5. 他人のユーザーディレクトリ配下にある`.codex/`全体、ログイン情報、会話履歴、ブラウザプロフィール、`.gitconfig`全体はコピーしません。GitHubやクラウドの招待を受けることと、他人のログイン状態を複製することは別です。

共通の指示を揃えても、モデル・個人設定・会話の違いによりAIの応答まで完全一致するとは限りません。`SOUL.md`、`USER.md`、`MEMORY.md`等はKOKOの文書規約であり、すべてが自動読込される特殊ファイルではありません。[AI環境の可搬性](architecture/portability.md)

## 9. 通常の共同開発を始める

本人のGit情報を確認します。iijimaの本人情報をコピーしてはいけません。公開リポジトリのcommitに記録されるメールを確認し、必要に応じて本人のGitHub設定に表示されたnoreplyアドレスを使います。

```powershell
git config --get user.name
git config --get user.email
```

未設定または変更が必要な場合だけ、以下の例を本人の値に置換し、KOKOだけへ設定します。

```powershell
git config --local user.name '本人の表示名'
git config --local user.email '本人が選んだメールアドレス'
git config --local blame.ignoreRevsFile .git-blame-ignore-revs
```

作業差分が空であることを確認して通常のmainへ戻ります。

```powershell
git status --short
git switch main
git pull origin main
```

この時点のmainが受渡しSHAより進んでいれば、開発開始点は更新されています。依存関係・検査も再確認します。変更を始める直前に、[Gitワークフロー](../.agents/skills/git-workflow/SKILL.md)に従って本人の苗字を使う作業ブランチを1つ作ります。mainへ直接pushしません。ブランチ名・commit・PRタイトル・PR前同期・merge後の削除規則は、同Skillを正本とします。

HTTPSでpushするときは本人のGitHub認証を使います。トークンをremote URL、Markdown、チャットへ貼り付けません。招待の承諾、2要素認証等のOrganization要件は本人が対応します。

## 10. 完了のチェックリストと困ったとき

- [ ] 受渡しcommit／treeとlockfileのhashを照合した。
- [ ] Node/npmの版が一致し、`npm ci --include=dev --strict-peer-deps`と`npm ls --all`が成功した。
- [ ] Husky・エディター整形を確認し、Playwrightの専用ブラウザを導入した。
- [ ] 全検査・build・E2Eが成功し、追跡ファイルに予期しない差分がない。
- [ ] ローカルの検証画面を表示できた。
- [ ] 必要な非公開資料は、権限を限定した共有先で取得・照合した（未取得なら未完了と記録）。
- [ ] Git本人情報とGitHub招待を確認した。Codexを使う場合は指示とSkillsも確認した。
- [ ] 実機・クラウドの未検証項目を開発環境の導入完了と混同していない。

| 症状                                   | 確認・対応                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `git`／`node`／`npm.cmd`が見つからない | インストールとPATH、PowerShellの開き直しを確認。秘密を含む環境変数一覧は送らない。        |
| `npm ci`のlock／peerエラー             | commit・Node/npm・ルートからの実行を確認。lockfile削除や強制installで解決しない。         |
| workspace／生成型が見つからない        | ルートでci後、`npm.cmd run build:contract`。dev・型検査・buildには契約buildを組込み済み。 |
| Chromium実行ファイルが見つからない     | 第5節のinstallを実行。独自ブラウザ保存先の設定がinstall／testで一致するか確認。           |
| hookがない／動かない                   | `.git`のあるcloneか、prepareが成功したか、HUSKYやignore-scriptsの設定を確認。             |
| 原資料や過去タスクがない               | 故障とは限らない。公開Gitの対象外なので、非公開共有の招待・取得状況を確認。               |
| GitHubでpushを拒否される               | 本人の認証・招待・作業ブランチを確認。main保護を解除しない。                              |

相談時は、実行したコマンド、OS／Node／npm、commit SHA、秘密を除いたエラーの必要部分を知らせてください。設定ファイル・ログ・資料フォルダーを丸ごと送らないでください。
