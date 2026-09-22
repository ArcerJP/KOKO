---
name: git-workflow
description: Git変更の確認、ファイルのステージング、commitの作成、ブランチの準備、remoteの設定または確認、変更のpush、GitHub Pull Requestの準備を行う際に使用します。
---

# Gitワークフロー

ユーザーの作業を保護し、操作をレビュー可能に保ち、認証情報を決して公開しません。

## 確認

1. リポジトリルート、現在のブランチ、作業ツリーの状態、適用されるタスク範囲を確認する。
2. どの変更をまとめるか決める前に、未ステージとステージ済みの差分を確認する。
3. 無関係、生成済み、機微、予想外に大きい、または追跡対象外のファイルを特定する。無関係なユーザー変更を破棄したり取り込んだりしない。

## ステージング

意図したパスを明示してステージします。より限定したパスを選べる場合に、機械的にgit add .を使用しません。秘密情報、非公開の原資料、非公開のタスク成果物、追跡対象外のローカルコンテキストを強制追加しません。

ステージング後にgit diff --cachedをレビューし、git diff --cached --checkを実行します。状態を再確認し、作業コピーを削除せずに意図しないパスをindexから除外します。

## コミット

Gitのユーザー情報を変更せずに確認します。ユーザー情報がない場合は、user.name、user.email、ローカルまたはグローバルの適用範囲をユーザーへ確認します。明示的な許可なくグローバル設定を変更しません。

commitメッセージは、`MMDD 苗字 接頭辞: 説明`の形式にします。日付にはcommit時点の月日4桁を使用し、苗字には実際の作業者を記載します。接頭辞にはfeature、feat、fix、refactor、docs、chore、test、perfなど、変更内容を明確に表す種類を使用します。例：`0811 iijima feat: 模擬店ページ作成`。

この形式は、履歴を見返した際に、いつ、誰が、どの種類の変更を積み重ねたかを素早く把握できるようにするためのものです。意味のまとまりごとにcommitを一貫させます。commit後は、成功を報告する前に状態と直近のログを確認します。

1つのcommitには1つの目的だけを含めます。デザイン修正、バグ修正、機能追加、機械的な一括整形など、独立して説明・取消しできる変更は別commitに分けます。無関係な変更を同じcommitへ混在させません。

## ブランチ、Remote、Push、PR

変更前に既存のブランチとremoteを確認します。GitHubリポジトリの作成には、所有者と公開範囲の明示が必要です。push、PRの作成、remoteの変更、ブランチの削除は外部状態を変更するため、ユーザーが依頼した範囲内でなければなりません。

mainへ直接pushしません。作業開始前にmainでgit pull origin mainを実行し、最新状態から作業ブランチを作成します。

ブランチ名は`苗字/接頭辞/内容`の形式にします。接頭辞にはfeature、feat、fix、refactor、docs、chore、test、perfなどを使用し、内容には小文字のkebab-caseで目的を記載します。例：`iijima/feature/add-mogitenpage`。

Pull Requestのタイトルは、commitメッセージと同じく`MMDD 苗字 接頭辞: 説明`の形式にします。日付にはPull Request作成時点の月日4桁を使用し、苗字には実際の作業者を記載します。接頭辞と説明にはPull Request全体の主目的を記載します。例：`0811 iijima feat: 模擬店ページ作成`。この形式により、履歴から変更日、作業者、変更種別、目的を素早く把握できるようにします。

1つのユーザー指示につき、原則として1つの作業ブランチと1つのPull Requestを使用します。目的のない予備ブランチや重複ブランチを作成しません。

Pull Requestを作成する直前に、作業ブランチ上でgit pull origin mainを実行します。競合を解消し、関連するテストとdocs/ci.mdで現在「導入済み」の検査をすべてローカルで再実行してから、作業ブランチをpushしてPull Requestを作成します。未導入または適用外の検査を成功扱いにせず、理由をPull Requestへ記載します。

### PushとPR作成のアカウント一致

同じPRの作業ブランチをpushするGitHubアカウントと、PRを作成するGitHubアカウントを一致させます。PR作成後の追加pushも、そのPR作成者のアカウントで行います。これはcommitのauthor／committerや`git config user.name`／`user.email`ではなく、GitHubへ操作を実行する認証アカウントの規則です。

1. 最初のpush前に、使用するGit認証経路と、その経路で選択されるGitHubアカウントを確認します。Gitの氏名・メールアドレスやremote URLだけでpushアカウントを判断しません。
2. PR作成に使うブラウザ、連携ツールまたはCLIの認証アカウントを、その経路自身で確認します。ブラウザのログイン状態や`gh auth status`だけから、別経路のGit／連携ツールも同じアカウントだと推定しません。
3. pushとPR作成のアカウントが一致することを確認できなければ、push・PR作成を止め、使用アカウントと認証方法をユーザーへ確認します。別アカウントのツールで代行しません。アカウントの切替え、資格情報の削除・再登録、グローバル設定の変更を無断で行いません。
4. PR作成後は実際のPR作成者を確認します。追加push前にもPR作成者とGit認証アカウントを照合し、不一致・確認不能なら停止します。確認記録にはアカウント名と確認手段だけを残し、トークンや資格情報を表示・保存しません。
5. レビューはPR作成者でも最後のpush実行者でもない、必要なWrite権限を持つ別の担当者が行います。別アカウントでの自己承認を、人間による独立したレビューの代わりにしません。AIは承認レビューやmergeを代行しません。
6. 既存PRで不一致が判明した場合は、PR作成者・最後のpush実行者・承認条件を確認し、ユーザーへ報告します。PRの閉鎖・再作成、履歴書換え、空commit、保護ルールの解除で回避せず、対応方針の承認を待ちます。

PR作成者は自身のPRを承認できません。また、「最後のreviewable pushを行った人以外の承認」が必要な設定では、pushとPR作成を分担すると承認可能な担当者を減らします。アカウント一致の確認はこの事故を防ぐ手順であり、CI・CODEOWNERS等の他のmerge条件を免除するものではありません。

根拠：[GitHub公式の承認レビュー](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)、[ブランチ保護の承認条件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

### Merge後の整理

Pull Requestがmergeされた後は、GitHubのDelete branchでremoteの作業ブランチを削除します。続いてローカルで次を順に実行します。

```powershell
git checkout main
git pull origin main
git branch -d <ブランチ名>
```

merge済みであることを確認できない場合や、git branch -dが拒否した場合は、force削除せず停止して状態を確認します。

フォーマットのセットアップと操作はdocs/formatting.mdに、CIの適用範囲と追加条件はdocs/ci.mdに従います。commit時の自動整形を信頼するだけでなく、ステージ済み差分を再確認します。

GitHub CLIを利用できる場合は、認証確認にgh auth statusを使用します。トークンを表示するオプションを使用したり、認証情報ファイルを公開したりしません。

## 明示的な許可がない場合の禁止事項

- git reset --hard
- git clean -fd または git clean -fdx
- force-with-leaseを含むforce push
- 対話的な履歴書き換え
- ブランチ、tag、remote、リポジトリの削除
- 既存remoteの上書き
- 既存変更の破棄
- mainへの直接push
- 現在の目的に不要な作業ブランチの作成

コマンドが部分的に成功した場合またはタイムアウトした場合は、再試行前にローカルとremoteの状態を確認します。
