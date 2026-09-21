# フォーマット規約

## 目的

改行コード、空白、インデントの表記ゆれを防ぎ、Pull Requestで本来の変更点を読み取りやすくします。

## 正本と参考資料

KOKOにおける正式なフォーマット規約は、この文書とリポジトリ直下の設定ファイルです。

ユーザー提供の原資料はknowledge/raw/FormatterSetting.pdfに改変せず保存します。このPDFは技科大祭HPリポジトリ向けの手順であるため、Prettier、EditorConfig、Husky、PR時チェックという一般原則を参考にし、KOKO固有の手順はこの文書で定義します。

## 適用範囲

- .editorconfigは、リポジトリ内のテキストファイル全体に適用します。
- Prettierは、Prettierが認識する追跡対象ファイルに適用します。
- PDF、非公開の動的コンテキスト、生成物は自動整形の対象外です。
- Node.jsとnpmは、リポジトリの整形処理にだけ使用します。KOKOのプロダクト技術スタックを決定するものではありません。

## 基本設定

- 文字コード：UTF-8。
- 改行コード：LF。
- インデント：半角スペース2個。
- ファイル末尾：改行あり。
- 行末の不要な空白：削除。
- Prettier：package.jsonとpackage-lock.jsonで固定したリポジトリローカル版を使用。

## 初回セットアップ

1. Node.js 22.22.1以上を用意します。CIではNode.js 24を使用します。
2. リポジトリルートで次を実行します。

```powershell
npm.cmd install
```

3. VS Codeまたは互換エディターを使用する場合は、次の推奨拡張機能をインストールします。

- Prettier - Code formatter（esbenp.prettier-vscode）
- EditorConfig for VS Code（EditorConfig.EditorConfig）

.vscode/extensions.jsonに推奨拡張機能を、.vscode/settings.jsonに保存時整形を設定しています。拡張機能のインストールは、各利用者が自身のエディターで実施します。

## 日常の操作

全対象ファイルを整形する場合：

```powershell
npm.cmd run format
```

変更せずに整形状態を確認する場合：

```powershell
npm.cmd run format:check
```

commit時にはHuskyとlint-stagedが、ステージ済みファイルのうちPrettier対応形式だけを自動整形します。整形によって差分が変わった場合は、commit前にその差分を再確認してください。

Pull RequestではGitHub ActionsのFormat Checkがnpm.cmd run format:check相当の検査を実行します。失敗した場合はローカルでnpm.cmd run formatを実行し、差分を確認してから再度commit、pushします。

## 改行コードの移行

KOKOでは初期構築時から.gitattributesでLFを指定しており、2026-09-20時点で追跡ファイルの改行状態も確認済みです。そのため、今回の導入でリポジトリの削除や再cloneは行いません。

将来.gitattributesを実質的に変更し、既存ファイルの正規化が必要になった場合は、通常の変更と混在させず、専用の一括整形commitとして計画・レビューします。

## git blame

.git-blame-ignore-revsには、機械的な一括整形だけを行ったcommitの完全なSHAだけを登録します。仕様変更や文書内容の変更を含むcommitは登録しません。

登録ファイルをローカルのgit blameへ適用するには、リポジトリ内で次を一度実行します。

```powershell
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Pull Requestと保護ルール

Format Checkをmainの必須status checkとしてGitHub RulesetまたはBranch protection ruleに登録すると、不合格のPull Requestをmergeできなくなります。リポジトリ設定の変更は、権限を持つ人がGitHub上で確認して実施します。

## 参照資料

- 原資料：[FormatterSetting.pdf](../knowledge/raw/FormatterSetting.pdf)
- Prettier公式：[Install](https://prettier.io/docs/install/)
- Husky公式：[Get started](https://typicode.github.io/husky/get-started.html)
- GitHub公式：[Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
