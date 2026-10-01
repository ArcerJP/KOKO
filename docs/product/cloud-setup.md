# クラウドの役割と準備ガイド

確認日：Cloudflare Workerの初回build・deploy成功と未認証アクセスの転送確認は2026-09-29、保存済みAccess設定の閲覧確認は2026-09-28〜29、専用トークンの作成・保存とBuilds登録成功のユーザー報告、Zero Trust Free有効化とWorker作成フォームの画面確認は2026-09-28、Vercelの初回配備・保護設定とCloudflareアカウント・R2の初期準備は2026-09-23、その他の準備・料金情報は2026-09-22。対象はB1-1〜B1-3の準備です。採用構成の正本は[プロダクト構成](../architecture/product-architecture.md)、費用判断の方針は[費用方針](cost-policy.md)です。確認済みの範囲は各節に記載し、全サービスの契約・課金・実連携や本番受け入れの完了とは区別します。

## まず何を用意するか

クラウドは、手元のPCを閉じてもアプリを動かすための「外部の設備」です。KOKOでは役割を分け、以下の5社を使う設計です。Googleログイン用の設定と画像処理は、同じGoogle Cloud側で準備できます。

| サービス     | KOKOでの役割                                                                         | 最初の準備                                               | 今回の実装に必要か               |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------- |
| Vercel       | Web画面の配信・確認用URL                                                             | アカウント、管理主体、GitHub連携権限の確認               | 不要。ローカルで起動可能         |
| Cloudflare   | Workers＝API、R2＝非公開保存、Stream＝動画処理・配信、Queues＝処理待ち行列           | アカウント、管理者、支払設定の担当を確認                 | 不要。まだ送信しない             |
| Supabase     | 投稿・権限のDB、Googleログインを受け付けるAuth                                       | アカウント、Organization、開発用プロジェクトの準備       | 不要。現在は契約・モックの試験   |
| Google Cloud | Cloud Run＝画像変換、Vision＝不適切画像・文字の検査、Google Auth Platform＝OAuth設定 | 管理用Googleアカウント、プロジェクト・請求担当の確認     | 不要。画像変換・実ログインは後続 |
| OpenAI API   | 写真・動画フレームの必須モデレーション                                               | API Platformのアカウント、組織・プロジェクト管理者の確認 | 不要。まだAIへ送信しない         |

Discordの通知先とGoogle Driveのアーカイブ先は、後続の運営準備です。今すべてを契約する必要はありません。

## iijimaさんが今行う順序

1. 各社について「アカウントあり／なし」「管理できる人」を確認してください。名義・契約主体・引継ぎ先は誰にしますか？個人のログインを共有せず、各サービスの招待機能で管理者を分ける方針です。
2. 下記の各社の公式画面からアカウントを準備し、多要素認証と復旧手段を設定してください。既存の管理用アカウントがあれば、新規作成前に利用可否を確認します。
3. まずアカウント準備までで止めて構いません。課金・カード登録・権限付与を求められたら、その画面のサービス名とプラン名を確認してください。支払情報をチャットへ送る必要はありません。
4. ドメインは未定のままで進められます。購入やDNS変更は今は不要です。初回配備時はサービス提供のHTTPS URLを利用する案を検討し、実OAuthの前に安定したURLを確定します。
5. 準備結果は「サービス名、準備済みか、選んだプラン、非秘密のプロジェクト名／ID、管理権限の有無」で知らせてください。まだ作っていない項目は「未作成」で十分です。

パスワード、APIキー、service_roleキー、OAuth Client Secret、Webhook URL、秘密鍵、復旧コードは送らないでください。スクリーンショットも、これらと個人の請求情報を隠してから共有します。必要な秘密は後続の設定時に、ご自身で指定されたSecret欄へ入力します。

## サービスごとの具体的な準備

### 1. Vercel：Web画面

#### 採用プランと確認済みの状態

- iijimaの承認によりHobbyを採用します。学祭時点は学生・個人の非商用プロジェクトで、Vercelの設定・管理は代表者1人が行います。有料機能、広告・有償協賛表示、商品・サービスの販売宣伝、開発・運営の報酬はいずれもありません。[Hobby条件](https://vercel.com/docs/plans/hobby)、[Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)
- 管理スコープは`Arcer`（URL上の識別子は`arcer2`）、プロジェクトは`koko-web`です。公開リポジトリ`ArcerJP/KOKO`との接続と、`main`の`c8b0f49`の初回配備成功を確認しました。`KOKO-private`は接続しません。
- GitHub Appの許可対象は`ArcerJP/KOKO`に限定する方針です。今回確認したのはVercel側の接続先であり、GitHub側のApp権限一覧は再確認していません。
- 確認用の固定URLは[https://koko-web-green.vercel.app/](https://koko-web-green.vercel.app/)です。現在は開発用の撮影・トリム画面で、Googleログイン・保存・AI判定には未接続です。Vercelの`Production`表示は配備先の区分であり、学祭向けの本番受け入れ完了を意味しません。

#### ビルド設定

`Settings → Build and Deployment`で以下を確認済みです。既存のnpm workspacesによるmonorepoをそのまま使用し、別のmonorepoツールは追加しません。

| 項目                                     | 設定                                  |
| ---------------------------------------- | ------------------------------------- |
| Framework Preset                         | Next.js                               |
| Root Directory                           | `apps/web`                            |
| Include files outside the root directory | 有効                                  |
| Build Command                            | `npm --prefix ../.. run build:web`    |
| Install Command                          | `npm ci --prefix=../.. --include=dev` |
| Output Directory                         | Next.jsの既定値（Overrideなし）       |
| Node.js Version                          | `24.x`                                |

`build:web`は共有契約を先にbuildしてからWebをbuildします。環境変数の指定値は`HUSKY=0`、`NEXT_TELEMETRY_DISABLED=1`で、適用先は両方ともProductionとPreviewです。2026-09-23の管理画面では登録名と適用先を確認し、値の表示・コピーは行っていません。Huskyの無効化はVercelのbuild環境だけで、ローカルのGitフックは変更しません。

#### 開発中の公開範囲

1. `Settings → Deployment Protection`の`Vercel Authentication`で`Require Log In`を有効にします。
2. iijimaの承認に基づき、`Standard Protection`から`All Deployments`へ変更して保存しました。設定の再読み込み後も選択が維持され、固定URLへのCookie・認証情報なしのHTTPアクセスは`302`で`vercel.com`へリダイレクトされることを確認しました。権限のあるログイン済みChromeでは検証画面の表示を確認しましたが、スマートフォンでの撮影・トリム操作は別途検証が必要です。
3. `Protected Sourcemaps`は有効のまま維持します。公開例外、保護を迂回するSecret・共有リンク、新たなTrusted Sourceは追加しません。Password Protection等の有料機能も有効化しません。

`Standard Protection`は本番ドメインを保護しません。`All Deployments`は本番を含めてVercelの閲覧権限を要求し、Hobbyでも追加料金なしで利用できます。開発画面の一般公開を防げる一方、権限のない共同開発者はそのままでは閲覧できません。共同検証でアクセスを追加する場合は、対象者・範囲を先に承認します。GitHubの共同開発権限やKOKO利用者向けのGoogleログインとは別の仕組みです。[Deployment Protection公式](https://vercel.com/docs/deployment-protection)

学祭向けに公開する前に、アプリ側の認証・認可、非公開メディア配信、実機検証と本番受け入れを完了し、公開範囲の変更について改めて承認を得ます。Hobbyの利用上限や商用条件、管理体制が変わる場合も再確認し、自動的に有料化しません。

#### 初回buildに残る警告

- `eslint@9.39.5`：2026-08-06でサポート終了。使用中のNext.js用Lint設定のプラグインとの互換性により、iijimaが暫定利用を承認済みです。互換性と検査を確認してから移行し、`--force`等で強制更新しません。[ESLintのサポート状況](https://eslint.org/version-support/)
- `msw`・`unrs-resolver`の`allow-scripts`：インストール時処理について許可・拒否が未記録という警告です。npmの版・設定によって処理の扱いが異なるため、警告だけを根拠に未実行または安全とは判断しません。内容と必要性を審査せず一括承認しません。[npmの承認機能](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/)

警告は配備失敗ではありませんが、既知の脆弱性検査が0件でもサポート終了や未審査の状態は解消されません。今回の設定操作では依存関係・承認ポリシーの変更や再デプロイは行っていません。

### 2. Cloudflare：API・保存・動画・処理待ち

#### 確認済みの状態

- GitHub連携でCloudflareアカウントを準備し、メール確認とTOTPによる2要素認証の有効化を確認しました。パスワード、TOTP seed、復旧コードは記録していません。
- 2026-09-28、iijima提供の申込み後のCloudflare One画面で、Account detailsのPlanが`Zero Trust Free`であることを確認しました。申込み画面の無料枠超過利用への課金同意を説明したうえで、Freeのみを有効化し、有料オプションを追加しない方針をiijimaが承認しました。今回の確認はプランの有効化までであり、アカウント全体の請求額が0であることや、開発用APIの保護完了を意味しません。支払情報は記録していません。[Zero Trust初期設定](https://developers.cloudflare.com/cloudflare-one/setup/)
- R2の従量課金を有効化しました。Cloudflareアカウント全体の従量課金が1請求期間に10 USDへ達した場合のBudget Alertを、管理者本人のメール1件へ設定済みです。通知は利用や課金を停止する上限ではありません。[Budget Alert公式](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- 開発用の非公開R2バケットとして、原本用`koko-dev-originals`と派生物用`koko-dev-derived`を作成しました。どちらもLocationはAutomatic（作成画面の選択先はAsia Pacific）、Default Storage ClassはStandard、Public Accessは無効です。作成後の一覧で2バケットと合計保存量0 Bを確認しました。
- 大学・実行委員会によるデータ保存地域の制約はないことをiijimaが確認しました。AutomaticのAsia Pacificは日本国内保存を保証する指定ではありません。[R2のデータ配置](https://developers.cloudflare.com/r2/reference/data-location/)
- `r2.dev`、Public custom domain、Bucket Lock、Lifecycle、ファイル投入は未設定です。保持期間の合意前に削除不能期間を作りません。
- Workers Builds用の専用User API Token `koko-api-dev-build`について、iijimaから作成・保存完了の報告を受けました。承認済みの範囲はKOKOで使用するCloudflareアカウント1件の`Workers:Admin`、TTLは2026-09-28開始・2026-10-19終了です。対象アカウント・権限・期間は、同日の発行後の要約画面でも確認しました。秘密の値は閲覧・取得・記録していません。初回のWorker作成に必要な権限であり、初期構築後は期限を待たず継続デプロイに必要な権限へ縮小します。未使用サービスの権限は先行付与せず、追加が必要になった時点で確認します。Workers Buildsへの登録と登録後の一覧照合は、同日の本人実行ログ`RESULT=REGISTERED_AND_VERIFIED`により成功を確認しました。その後、承認済みの画面再読み込み・入力復元・既存トークン選択を行い、Worker作成フォームの選択値を確認しました。注意表示の内部判定の原因は未確定ですが、2026-09-29にこのトークンを選択した初回ビルドのdeploy成功を確認しました。権限縮小は未完了です。[トークン作成と変更](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[Workersの権限](https://developers.cloudflare.com/workers/authorization/workers/)
- Worker基盤は`apps/api/`に実装し、`GET /health`、開発用R2 binding、ローカルテスト、dry-run buildを追加しました。型検査・テスト・buildのGitHub Actionsも実行成功を確認しています。2026-09-28〜29のユーザー提供画像と読み取り専用確認により、Cloudflare上の`koko-api-dev`作成、`ArcerJP/KOKO`の`main`への接続、本人操作による初回Build `41b7ab63`の開始、その後のbuild・deploy成功を確認しました。所要時間は5分39秒で、2026-09-29の画面ログに`Success: Deploy command completed`と`Success! Build completed.`が表示されました。配備先は[開発API](https://koko-api-dev.arcer-jp.workers.dev/health)、R2 bindingは`ORIGINALS_BUCKET`と`DERIVED_BUCKET`です。初期化中の概要ではURL無効・Bindings 0でしたが、完了ログではURLと2つのbindingが報告されました。同日、本人から認証後の動作確認完了の報告と、固定URLの`/health`に`{"service":"koko-api","status":"ok"}`が表示された画像を受け取りました。認証情報やセッションは取得していません。実R2読書きは未検証です。ビルド成功・API応答・bindingの配備・R2実接続検証を区別します。必須checkの導入順序は[CI規約](../ci.md#新しい必須checkを導入する順序)を参照してください。

#### 残る準備

1. Workers、R2、Stream、Queuesは別々の課金項目です。Webサイト向けの「Pro」契約と「Workers Paid」も別です。
2. B1-1の残りとして、開発専用Workers、Queues、Streamを本番資源と分離して準備します。資源名・プラン・保持期間は作成前に確認します。
3. R2の`r2.dev`公開とPublic custom domainを有効にしません。Streamは常時署名必須です。Bucket Lockは削除できない期間を作るため、保持期間の合意前には設定しません。
4. 接続時には対象資源を限定した資格情報を用意し、Global API Keyをアプリに使いません。値はSecretストアへ設定します。
5. 開発用APIをCloudflare Accessで保護する方針は承認済みです。2026-09-28、初回の許可対象はiijima本人のみとし、共同開発者は後から追加する方針をiijimaが承認しました。本人を識別するメールアドレス1件も確認・承認済みです。値は公開文書へ記載せず、メールドメイン全体やCloudflareアカウントの全メンバーを許可する設定と混同しません。Zero Trust Freeの有効化とWorker作成フォームでの選択に続き、初回ビルド開始後のWorkerのAccessタブで`Worker Access All traffic`、本番・Previewの全URLでログイン必須、`koko-dev-iijima-only`、承認済み本人メール1件の`Allow`を確認しました。2026-09-29の配備後、固定URLの`/health`へCookie・認証情報なし、リダイレクト追従なしでGETし、HTTP 302でCloudflare Accessログイン先へ転送されることを確認しました。最初の検査はローカル実行環境の接続制限で失敗し、制限外の読み取り専用再実行で確認しています。その後、本人の認証後の正常応答を本人報告と画像で確認しました。配備一覧のリンクから取得したVersion URL 3件（現行`a40d491f`、旧版`f2833009`・`82d3e774`）の`/health`も、同じ未認証条件でGETし、いずれも302でAccessへ転送されました。認証方式・MFAの実効設定、許可対象外の認証済み利用者の拒否試験は未確認です。全URL保護の設定と、実際に試した固定URL・3つのVersion URLの保護動作を区別します。KOKO利用者向けのGoogleログインとは別の開発用アクセス制御であり、このデプロイ用トークンへAccess管理権限を追加するものではありません。[WorkersのAccess保護](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

##### 項目別の進捗（2026-09-29確認）

上の番号は順番に完了するチェックリストではなく、準備作業と継続して守る条件が混在しています。現在は「2のWorkers初回配備と本人のAPI応答確認、4のBuilds用資格情報の実利用、5のAccess設定保存・本人認証後の正常応答・固定URLと3つのVersion URLの未認証アクセス制限」まで進んでいます。Cloudflare全体の準備完了ではありません。

| 残る準備                           | 現在の状態                                                                                     | 次の確認・作業                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1：課金の区分                      | 継続確認。R2・Zero Trust Freeの準備記録あり。他製品の契約完了とは別                            | Queues・Stream等の準備前に対象プラン・費用を確認                                |
| 2：開発専用Workers・Queues・Stream | 一部完了。Worker作成・GitHub main接続・初回配備・本人のAPI応答確認済み。R2 binding 2件配備済み | 未作成のQueues・Streamを準備。実R2読書きの検証は別途                            |
| 3：非公開化・署名・保持            | 継続条件。R2は非公開として準備済み。Streamは未準備                                             | R2公開を有効にせず維持。Stream作成時に署名必須、保持期間合意前はBucket Lockなし |
| 4：限定した資格情報                | 一部完了。専用build tokenの実利用と補助用削除を確認。移行のworkflow・試験・文書をローカル実装  | ローカル変更をレビュー後、別途承認で外部移行。権限縮小・Actions実配備は未完了   |
| 5：本人限定Access                  | 設定保存、本人認証後の正常応答、固定URLとVersion URL 3件の未認証GET→Accessへの302転送を確認    | 認証方式・MFAの実効設定、認証済み対象外利用者の拒否試験                         |

直近の作業は「4：限定した資格情報」の整理です。残るAccess検証は未完了項目として保持し、資格情報整理の後にQueues・Streamの構成・費用・保持期間を確認します。初回ビルドのやり直しは不要です。設定変更・権限縮小・失効操作は別途確認し、勝手に実行しません。

2026-09-29、iijimaは、`koko-api-dev-build`を対象Worker `koko-api-dev`だけの`Editor`へ縮小し、対象アカウントと期限2026-10-19を維持すること、および登録作業が終わった`koko-builds-register-once`の失効を承認しました。ただし、既存User API Tokenをそのまま個別Worker限定へ編集できるという当初案は、後述のトークン種別とBuildsの対応制限を考慮していませんでした。この案での権限縮小は未実施です。Buildsでは編集済みトークンが古い状態として扱われる場合もあり、新規発行・再登録・再配備を自動で進めません。[Buildsの古いトークンに関する注意](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#stale-api-token)

同日の編集画面では、既存トークンの`Account → Workers`の権限候補は`Admin`のみで、対象の種類も`Account`・`Zone`・`User`でした。個別Workerと`Editor`を指定する項目は確認できず、権限やTTLを変更・保存せず一覧へ戻りました。アカウント全体の旧`Workers Scripts: Edit`は個別Worker限定の代わりにはならず、無断で採用しません。配備用トークンは対象アカウント1件の`Workers:Admin`と期限2026-10-19のままです。

同日、iijimaの承認を受け、設定変更なしで別経路を調査しました。公式文書はWranglerの資源単位権限に**Account API Token**を指定しています。実際の`Manage account → Account API tokens`の作成画面でも、`Specified Workers`とWorkersの`Editor`を確認しました。既存User API Tokenの編集画面とは別の経路です。ただし、Workerの選択・権限の入力・トークンの発行は行っておらず、この資格情報による実配備も未検証です。未保存で一覧へ戻り、Account API Tokenが未作成の状態を確認しました。[Wranglerでの資源単位権限](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler)、[Account API Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

**Workers Buildsは同日の公式文書上、配備用トークンとしてUser API Tokenだけに対応し、Account API Tokenは未対応です。** Builds管理APIも別途User API Tokenを要求するため、登録API経由でAccount API Tokenを持ち込めるとは判断しません。[Buildsの配備用トークン制限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)、[Builds管理APIの認証](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)

個別Worker限定を優先する代案は、対象`koko-api-dev`だけのWorkers `Editor`を持つAccount API Tokenを新たに用意し、APIの配備をGitHub Actions等の外部CIから既存Wranglerで行う構成です。Worker・R2・Access・Vercelを作り直す案ではありません。別Workerへの権限を除ける利点がある一方、配備workflow、Secret管理、Buildsとの二重配備防止、期限更新の保守が増えます。対象Workerの更新権限やbinding経由のデータへの影響までなくなるわけではありません。公式の対応経路に基づく提案であり、KOKOでの動作保証ではありません。[GitHub Actionsからの公式配備手順](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

その後、iijimaは具体的な移行計画の作成を承認し、通常運用は「初回検証後、mainへのマージで自動配備」を選択しました。2026-09-29に計画案を作成し、続けて「外部設定を変更しない配備の仕組み・テスト・文書のローカル実装」まで承認を受けました。workflow・実行ガード・回帰試験・文書をローカルへ追加し、CI相当の検証を完了しました。同日、commit・push・PR作成まで追加承認を受けました。初期の自動配備OFF、導入PRのmerge前のBuilds切断、本人の手動受入、旧トークン失効、その後の自動化という順序は下記にまとめます。発行、Secret登録、Builds切断、Actionsでの配備、旧配備用トークン失効は今回の許可に含まれず、未実施です。PR作成やCI成功を外部適用済みと扱いません。

補助用`koko-builds-register-once`は削除直前の一覧で`Expires soon`でした。画面の失効手段が`Delete`のため、復元できないことと配備用トークン・Workerを削除しないことを説明し、iijimaから「補助用トークンだけ削除してよい」と実行時点の承認を受けました。同名の削除確認ダイアログを照合して実行し、削除後の未絞り込み一覧から補助用が消え、配備用だけが残ることを確認しました。補助用トークンは復元できません。配備用の編集保存、Builds設定変更、再登録、再配備は行っていません。

#### GitHub Actionsへの移行手順（外部操作は別途承認）

2026-09-29時点ではローカル実装のみです。採用理由は[ADR-0003](../decisions/ADR-0003-worker-scoped-deployment.md)、実行条件と自動テストは[CI規約](../ci.md#開発用api配備)を参照してください。下表は移行時の設定案であり、設定済みの一覧ではありません。

| 項目                | 設定案・保存先                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 対象                | 既存の開発用Worker `koko-api-dev`のみ。Worker・URL・R2・Accessは維持                                                  |
| 新資格情報          | `koko-api-dev-deploy`というAccount API Token。対象アカウント1件、Specified Workersで当該Worker1件、Workers Editorのみ |
| 期限                | 発行前に再確認。提案上限は2026-10-19。発行日と画面の終了日・APIのUTC失効日時を照合し、無期限にしない                  |
| GitHub Environment  | `koko-api-dev`を管理者が事前作成。Deployment branches and tagsはBranch型の`main`だけ。Tagは追加しない                 |
| Environment Secrets | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。実値は本人が入力し、ログ・Git・チャット・成果物へ残さない            |
| Repository variable | `KOKO_API_AUTO_DEPLOY_ENABLED`。移行時は`false`、受入後だけ`true`。同名Environment variableを作って値を上書きしない   |
| 実行先              | 標準GitHub-hosted Linux runner。専用・有料runnerや追加課金の申込みなし。適用前に利用条件を確認                        |

Environmentが既にあれば、Secret値は再表示せず、用途・保護・同名変数の衝突を確認してから進めます。既存設定の上書き、reviewerの削除、Repository/Organization Secretsへの代替登録は行いません。通常はmainのPRレビューを承認境界とするため、新たな毎回のEnvironment reviewerは設けない案ですが、既存reviewerがあれば確認します。main限定の保護を設定する前にworkflowを手動実行しないでください。

1. **ローカル変更のレビュー・PR準備**：外部設定や実配備を含まない差分と検証結果を確認。commit・push・PRは対象ファイルとbranchを示し、承認後にGit-E-z7で実施。PRのレビューとmergeは人間が担当し、この時点ではまだmergeしない。
2. **移行先の準備**：実行時点で対象・期限・保管先の承認を取り、上表のEnvironment・フラグ・新資格情報を準備。対象Worker1件とEditorを選べなければ発行せず停止。Account API TokenをBuildsへ登録しない。
3. **旧経路の停止**：初回作業中はmain更新を止める時間帯を合意。正常なActive Deploymentの完全Version IDを記録し、実行中・待機中Buildがないことを確認して、対象WorkerのSettings → Builds → Disconnectだけを承認後に実施。設定・履歴削除を伴う画面なら、その影響も確認。Worker削除やGitHub App全体の解除はしない。
4. **初回の手動受入**：旧経路の切断を再読込で確認した後に本人が導入PRをmerge。pushで検証だけが動き、deployがOFFであることを確認してから、本人が`API Deploy`を`main`で1回手動実行。下記の受入を行う。
5. **旧資格情報の整理**：受入合格後、旧`koko-api-dev-build`を他で使用していないことを確認。元User API Tokenの失効を別途承認後に実施。復元不可の削除は対象を再確認し、Builds側の登録名削除だけで代替しない。
6. **自動配備の有効化**：受入と旧トークン失効の後に、別途承認を受けてRepository variableを`true`へ変更。次の必要な変更を通常どおりPRレビュー・mainへmergeし、自動配備を確認。検証のための空commitは作らない。

導入PRのmergeより前に旧Buildsを止め、2経路からの配備を避けます。GitHub側のconcurrencyではBuildsからの配備を制御できません。自動配備を有効にしただけでは過去のpushは再実行されず、「有効化済み」と「自動実行の実証済み」を区別します。

##### 初回と自動化後の受入

- 新トークンの保存済みpolicyが、対象Worker1件のEditorだけ・期限ありであることを確認。All Workers／Entire Accountや追加policyの混入を除外。
- GitHub runのcommit SHAとCloudflareの新Version・Active Deploymentの対応を記録。
- Worker名・固定URL・R2 binding 2件・Access All trafficと本人限定が配備前と一致。
- 未認証・Cookieなし・リダイレクト非追従の固定URLと新Version URLの`/health`が、既知のAccessログイン先へ302。単に302というだけでは合格にしない。
- 本人が認証後、固定URLで`{"service":"koko-api","status":"ok"}`を確認。CI用にAccessを無効化・迂回しない。
- 他資源の変更、データ投入、秘密のログ出力、旧Buildsからの新規配備がないことを確認。
- 自動化後は、次の正当なmain更新でも同じ条件を確認。それまでは自動実行の実証待ちとして記録。

別Workerへの拒否試験は、既存の対象と読取り専用APIを本人が承認した場合だけ行います。不存在の404を権限拒否の証明にしたり、試験用Workerを無断作成したりしません。policy確認と実拒否試験の有無を分けます。

##### 失敗時・期限更新

- 設定・資格情報の不足では、Adminやアカウント全体へ権限を広げず停止します。初回手動受入に失敗したまま自動化を有効にしません。
- 通信切断・タイムアウト・配備失敗では、書込みが未実行とは断定しません。Active Deploymentを読取りで照合し、再試行や復旧の対象を確認します。
- 新Versionに問題があれば、承認後に事前記録した正常VersionへRollbackします。旧トークン失効後は復元できません。広いトークンの再発行やBuilds再接続を自動で行いません。
- Rollbackはコード配備を戻す操作であり、Access設定、R2データ、GitHub設定・削除したSecretを復元しません。Access異常があれば直ちに報告し、保護復旧の操作を確認します。
- 期限更新はiijimaが担当する案です。期限前に同じ対象・権限の後継資格情報を承認して発行し、Environment Secret更新→配備確認→旧資格情報失効の順。無断延長・自動更新用の強い資格情報・Global API Keyは使いません。

公式手順：[Buildsの切断](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds)、[Environment管理](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[Workers Rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。適用直前にUIと仕様を再確認します。

#### Workers Buildsの初回入力と確認状況

2026-09-28のユーザー提供画面と、現在の`package.json`、`apps/api/package.json`、`apps/api/wrangler.jsonc`を照合した初回入力の記録です。同日の読み取り専用確認に続き、iijimaの明示的な承認を受けて画面を再読み込みし、初期化された入力を復元しました。作成フォームの名前・Path・コマンド・3つの変数・Preview OFF・Access ONと下記の保護設定を照合し、API tokenに既存の`koko-api-dev-build`を選択した状態を確認しました。その後、本人が初回ビルドを開始し、Build `41b7ab63`の画面で`main`、両コマンド、`apps/api`、選択トークン、3変数の名前と最終成功を確認しました。Accessの保存済み設定は上記のとおりです。ログではNode.js 24.16.0の導入とSKIP_DEPENDENCY_INSTALLによる自動導入省略を確認しました。変数欄の値とPreview builds OFFの保存後の再照合は未実施です。Codexは今回、設定変更・ビルド取消・再Deployを行っていません。

| 画面の項目                     | 入力・選択                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Repository                     | `ArcerJP/KOKO`。`KOKO-private`は接続しない                                   |
| Project name                   | `koko-api-dev`。Wranglerの`name`と一致させる                                 |
| Git branch（表示される場合）   | `main`                                                                       |
| Advanced settings → Path       | `apps/api`。先頭の`/`は付けない                                              |
| Build command                  | 下記のコマンドを1行で入力                                                    |
| Deploy command                 | `npm run deploy`                                                             |
| Enable Preview builds          | 初回はOFF。Preview資源の分離・保護確認後に有効化を検討                       |
| Preview command                | `npx wrangler preview`の既定値を維持。Preview無効中は使用しない              |
| Protect with Cloudflare Access | ON。下記のScopeと本人限定ポリシーの両方を確認                                |
| Scope                          | `All traffic`。`Previews only`では本番URLを保護しない                        |
| Authentication policy          | `koko-dev-iijima-only`を選択済み。`Allow`で承認済み本人メール1件だけを許可   |
| Session duration               | Worker作成フォームでは`24 hours`と表示されることを確認                       |
| API token                      | 既存の`koko-api-dev-build`を選択済み。権限不足の注意表示は下記で区別して記録 |
| API token name                 | 新規作成用のため入力しない。既存選択時の表示が異なれば再確認                 |
| Variable name／Variable value  | 下記のビルド変数を3組追加                                                    |
| Encrypt                        | 下記3変数は秘密ではないため不要                                              |

Build command：

```sh
npm ci --prefix ../.. --include=dev --strict-peer-deps && npm --prefix ../.. run build:api
```

`apps/api`からリポジトリルートのlockfileに従って依存関係を導入し、APIの型生成整合性とdry-run buildを検査します。rootの`npm run build`はWebも含むため使用しません。Deploy commandは、リポジトリで固定したWranglerを使う`wrangler deploy --strict`を呼び出します。Preview commandを別のデプロイコマンドへ置き換えません。

| Variable name             | Variable value | 目的                                                        |
| ------------------------- | -------------- | ----------------------------------------------------------- |
| `NODE_VERSION`            | `24.16.0`      | 今回検証したローカルのNode.jsに合わせる                     |
| `SKIP_DEPENDENCY_INSTALL` | `1`            | Cloudflareの自動導入を止め、Build command内の`npm ci`を使う |
| `HUSKY`                   | `0`            | ビルド環境ではローカル開発用Gitフックを導入しない           |

これらはWorkers Builds用の変数です。APIトークン、メールアドレス、Supabase等の秘密をこの表へ追加しません。API tokenの候補に専用トークンがなければ、`Create new token`による広い権限の自動発行へ切り替えず、画面の選択肢を確認します。API token nameや通常のVariable valueへトークンを貼り付けません。

2026-09-28のユーザー提供画面ではAPI token候補が`Create new token`だけでした。同日の読み取り専用確認では、User API Tokens一覧に`koko-api-dev-build`、対象1 Account、期限2026-10-19が表示されました。トークンの発行とWorkers Buildsへの登録は区別します。公式APIにはビルド用トークンの登録・一覧取得があり、既存トークンの名前・ID・秘密値を使う登録経路を確認しました。ただし、今回の候補欠落の原因が未登録だけであることは未確定です。本人の端末での自己検証・停止・修正後の登録成功は後述のとおりです。デプロイ用トークンの権限を無断で増やさず、秘密値をチャット・Git・通常ログへ含めません。[Builds APIの認証とトークン一覧](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)、[ビルド用トークンの登録API](https://developers.cloudflare.com/api/resources/workers_builds/subresources/tokens/methods/create/)

同日、iijimaが「対象アカウント1件・1日限定・Builds管理権限だけの補助用トークンを用意し、既存トークンを公式APIでBuildsへ登録する方法」を承認しました。別タブで補助用User API Token `koko-builds-register-once`の発行前の確認画面まで準備し、対象がKOKO用アカウント1件、権限が`Workers Builds Configuration: Edit`のみ、TTLが2026-09-28開始・2026-09-29終了であることを確認しました。日付選択欄と確認画面に終了日の差が生じたため、確認画面の終了日を基準に修正・再確認しました。Codexは`Create Token`を押さず、発行と秘密値の安全な保存を本人へ引き継いだ後、本人から作成・保存完了の報告を受けました。秘密値は閲覧・取得していません。API登録は本人実行ログで成功を確認しました。補助用は翌日の別途承認に基づき削除済みです。現在の状態は上記「項目別の進捗」を参照してください。この登録作業の承認にWorkerのDeployは含めません。

登録は本人の端末で次の順に行います。ローカルの一回用補助手順はGit除外済みの`tmp/`に置き、対象アカウントとトークン名を固定しています。トークンの実値をファイル、コマンド引数、環境変数へ保存せず、伏せ字の入力欄で受け取ります。HTTPS送信に必要な間だけプロセス内で値を扱い、Cloudflare公式API以外への送信とリダイレクトを禁止します。

1. 補助用トークン、既存のデプロイ用トークンの順に、本人が保存済みの値を入力します。各トークン自身の`GET /user/tokens/verify`でID・有効状態・期限を確認します。期限の想定差があれば停止し、トークン名・権限までAPIで再確認できたと誤認しません。
2. 補助用トークンで対象アカウントのBuilds登録一覧を取得します。名前と元トークンIDが一致していれば再作成せず、同名の別IDや複数一致は停止します。
3. 未登録なら、本人の`REGISTER`入力後に限り`POST /accounts/{account_id}/builds/tokens`を1回実行します。Workerの作成・deploy・権限変更は行いません。
4. 一覧を再取得し、名前・元トークンID・Builds UUIDの一致を確認します。通信失敗等で結果が不確定なら自動再試行せず停止し、後から読み取りで状態を確認します。本人から受け取るのは秘密を含まない`RESULT=`の結果行と、期限照合に失敗した場合の`DIAG_`で始まる整形済み日時行だけとします。トークン値・ID・生レスポンスは受け取りません。
5. 実登録の確認後、Workers画面で既存トークンを選択できるか確認し、補助用トークンの失効を別途確認します。今回の既存トークン選択と補助用削除の結果は、上記「項目別の進捗」を参照してください。

同日のPowerShell `7.6.5`で、成功・登録済み・衝突・取消・認証拒否・期限不一致・不正な応答・POST通信失敗・登録後不一致・ページング等の模擬テスト13件が成功しました。実資格情報や実ネットワークは使っていません。Windows PowerShellでは実行ポリシーにより起動できず、ポリシーを変更せず既存のPowerShell 7を使用しました。模擬成功を実際のAPI登録完了と混同しません。[トークン自己検証](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/)

その後、本人の実行結果として`RESULT=STOPPED STAGE=HELPER_VERIFY REASON=TOKEN_EXPIRY_MISMATCH`と`WRITE_ATTEMPTED=NO`を受け取りました。コードの分岐上、1番目に入力されたトークンの自己検証APIは成功し、有効状態の確認後、ローカルの期限比較で停止しています。入力されたトークンの名前はこのAPIでは分かりません。PowerShellがJSONの日時を`DateTime`へ変換した後、文字列への再変換でUTC情報を失い、日本時間として再解釈する不具合をローカルで再現しました。例として`2026-09-29T00:00:00Z`が旧処理ではUTC日付`2026-09-28`となりました。元の13件は日時を文字列のまま模擬しており、この変換を検証できていませんでした。

時差情報を保持したUTC正規化へ修正し、実際のJSON変換、UTC／ローカルの`DateTime`、`DateTimeOffset`、時差付き文字列、期限切れ・不一致・不明な時差の拒否等を含む28件のローカル模擬テストが成功しました。期限の承認値・チェック自体は緩和せず、再度停止する場合は秘密を含まない日時だけを表示します。この時点では実登録成功は未確認でした。[PowerShellのJSON日時変換](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json?view=powershell-7.6)

修正後の本人の再実行では、1番目のトークンについて、期待UTC日付`2026-09-29`に対してAPI期限`2026-10-18T23:59:59Z`、実行時刻`2026-09-28T14:05:31Z`が報告され、同じ期限不一致で停止しました。書込みは未実行です。返された期限は日本時間2026-10-19 08:59:59で、1日限定の補助用トークンの承認期限と約3週間異なります。既存のデプロイ用トークンとの入力取り違え、または発行時の期限違いの可能性があり、どちらかは未確定です。期限チェックを緩めたりトークンを再発行したりせず、本人が1番目に入力した保存データの名前を確認します。画面の終了日とAPIのUTC日時の対応も、トークンの識別後に照合します。

続く本人の実行結果ではAPI期限が`2026-09-28T23:59:59Z`、実行時刻が`2026-09-28T14:08:25Z`となり、約3週間の期限差は解消しました。これは日本時間2026-09-29 08:59:59で、公式文書が説明する選択日2026-09-29の00:00 UTC境界の1秒前です。UTC日付だけの一致ではこの値を拒否してしまうため、補助用・デプロイ用の両方を、承認済み終了日の00:00 UTCを上限、その1秒前を下限とする時刻比較へ修正しました。この1秒区間内でも、現在時刻がAPIの実際の期限に達していれば拒否します。Cloudflare側の期限・権限は変更していません。APIの期限を任意の長さまで受け入れたり、日付全体を許可したりはしません。[公式TTLの基準時刻](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/#time-to-live-ttl-constraints)

本人報告の最終秒を模擬した両トークンの登録フロー、補助用への長期トークン入力、区間外、上限を1単位でも超える期限、実際の期限ちょうどでの失効を追加し、修正版35件のローカル模擬テストが成功しました。この修正前の本人報告も`WRITE_ATTEMPTED=NO`であり、それまで登録書込みは行われていませんでした。

同日、修正版を本人が実行し、2つの伏せ字入力と`REGISTER`の確認後に`RESULT=REGISTERED_AND_VERIFIED`が出たログを受け取りました。ローカルコード上、この結果は登録POSTの応答と、その後のGET一覧で名前・元トークンID・Builds UUIDを照合した場合だけ表示されます。本人実行ログを根拠とする登録成功であり、Codexが秘密値を取得してAPIを再実行したものではありません。登録コマンドの再実行は不要です。

登録成功報告直後の読み取り専用確認では、入力済みのWorker作成フォームでAPI token候補を展開しても`Create new token`だけでした。その後、iijimaから再読み込み・消えた入力の復元・`koko-api-dev-build`の選択までの明示的な承認を受けました。再読み込みによりリポジトリ選択へ戻ったため、既存GitHub連携の`ArcerJP/KOKO`を再選択して入力を復元し、専用トークンが候補に表示され、選択値として維持されることを確認しました。再読み込み前の表示が残っていた可能性はありますが、内部原因は断定しません。新規トークン作成・保存・Deployは行っていません。

既存トークンの選択後、フォームに`Note: This API token is missing the following permissions:`の注意表示が残りました。`workers_scripts_write`、`workers_r2_write`等に加え、D1、Vectorize、Containers等の今回未使用の権限も列挙されています。同日、iijimaの依頼により、設定変更なしでUser API Tokensの`View summary`、公式の権限仕様、ローカルの配備設定・Wrangler実装を調査しました。現行の要約画面でも対象アカウント1件の`Workers:Admin`と承認済みTTLを確認しました。秘密値、編集画面、再発行・削除にはアクセスしていません。

今回の配備対象は`apps/api/wrangler.jsonc`で指定した`koko-api-dev`、`workers.dev`、既存R2バケット2件へのbindingです。Routes・Custom Domains、KV、D1、Queues、AI、Vectorize、Containers等の作成・変更は配備設定に含まれません。公式仕様に基づく必要権限は次のとおりです。

| 操作・資源                                  | 今回の必要性と最小権限                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workerの新規作成                            | 対象アカウントのWorkers productに対する`Admin`。現在の設定に一致                                                               |
| 作成後の既存Workerへの継続配備              | 資源単位では対象Workerの`Editor`。WranglerではAccount API Tokenを使う経路。現行Buildsは未対応のため、上記の移行案を別途判断    |
| 既存R2へのbindingを含む配備                 | Workerの権限で可能。bindingの配備だけにR2の別権限は不要。バケット作成・一覧・オブジェクト操作等を直接API実行する場合は別途必要 |
| Routes・Custom Domains                      | 今回は未設定。追加・変更時にだけ対象zoneの`Workers Routes Write`を検討                                                         |
| KV・D1・Queues・AI・Vectorize・Containers等 | 今回の配備では作成・管理しないため追加しない。後続機能とは分ける                                                               |
| Builds管理API                               | 補助用トークンの用途。Workerを配備するbuild tokenとは別で、今回その権限を追加する理由にはならない                              |

根拠：[Workersの作成・更新・bindingと旧権限の対応](https://developers.cloudflare.com/workers/authorization/workers/)、[Builds管理APIとbuild tokenの区別](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)。

注意表示の原因について、確認できたのは、新しい`Workers:Admin`を持つトークンに対し、画面が旧名の`workers_scripts_write`と広範な他サービス権限を不足として並べていることです。公式の新旧対応ではWorkers Scripts EditはWorkersの`Editor`に対応し、新規作成には`Admin`が必要です。このため、汎用的な旧権限一覧との比較、または新しい権限の認識・登録情報との不整合が原因候補です。ただし、画面内部の判定実装は未確認であり、不具合と断定しません。公式の[Builds設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)にある自動発行用の権限一覧も、今回の構成に必要な最小権限の一覧とは区別します。

初回配備前の調査時点のWrangler `4.136.3`のローカル実装では、binding先の存在確認が403になった場合に自動作成をスキップし、明示済みのR2バケット名を残して配備へ進む分岐を確認しました。これは実際のAPI成功の証拠ではなく、バケットの存在・最終アップロードは実環境で確認が必要です。また、アカウントの自動検出とWorkerの配備権限も別です。Builds実行環境でのアカウントID受渡しは未検証であり、自動検出に失敗した場合は、User Details／Memberships等を一括追加する前に`CLOUDFLARE_ACCOUNT_ID`の指定を検討します。

権限調査時点の推奨は、既存トークンの権限を増やさず維持することでした。その後、本人が開始した初回ビルドで、このトークンを使ったdeploy成功を確認しました。今回の配備に警告の全権限を追加する必要はなかったと判断しますが、警告の内部原因や後続機能に必要な権限まで確定したものではありません。後続で認証・権限エラーが出た場合は対象APIと実際に不足する権限を特定します。警告を消す目的の一括追加、トークン再発行、登録のやり直しは行いません。Codexは調査・進捗確認に伴う設定変更・Deployを行っておらず、残件は上記「項目別の進捗」に集約します。

初回deployのログでは、R2 bindingの存在確認権限がないため自動作成を省略する警告が出ましたが、既存バケット2件のbindingを含む配備は成功しました。実際のR2読書きは未検証です。また、`preview_urls`が未指定のためPreview URLs（現行文書のVersion URLs）を既定で有効にする警告も出ました。これはGitブランチの`Enable Preview builds`とは別の設定であり、OFFと矛盾する証拠にはなりません。Version URLsは別環境を作らず対象バージョンの資源を利用します。`All traffic`の保護設定に加え、現在の一覧にあるVersion URL 3件の未認証アクセスがAccessへ転送されることを確認しました。無効化する場合は設定変更と再配備が必要になり得るため、別途方針を確認します。[Version URLsの動作と設定](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)

`cfut_`はUser API Tokenの正式な接頭辞であり、本人は保存したトークン全体を末尾まで入力します。接頭辞・末尾の削除や、`Bearer`と空白の追加は行いません。補助手順は接頭辞を含む値を変更せず扱うことを模擬入力で検証済みです。[Cloudflareのトークン形式](https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/)

AccessのON表示だけでは本人限定・全URL保護を確認できません。初期のユーザー提供画面では`Previews only`・Authentication policy未選択でしたが、その後の入力と同日の読み取り専用確認で、このWorkerの本番・Preview双方を対象とする`All traffic`、Authentication policyの`koko-dev-iijima-only`、Actionの`Allow`、承認済み本人メール1件の選択を確認しました。さらに初回ビルド開始後のAccessタブでも保存済み設定を確認しました。フォーム上の選択、設定保存、実際の認証・拒否動作を区別します。メールドメイン全体、Cloudflareアカウントの全メンバー、全Workerを対象にした保護へ無断で拡大しません。後続の確認で保護設定が失われている場合は、実データの接続・投入をせず停止して再確認します。

保存前のポリシー画像ではPolicy session durationは未選択、MFAの個別上書きとJust-in-time accessはOFF、RDPのText／File controlsは既定の無効設定でした。その後のWorker作成フォームではSession durationが`24 hours`と表示されました。未指定のpolicy session durationはアプリ側の時間を継承します。MFAの上書きOFFは上位設定を継承する指定であり、AccessでMFAが必須になっていることの証明ではありません。Cloudflare管理アカウントの2要素認証とも区別し、実接続前にAccess側の認証方法・実効セッション時間・MFA設定を確認します。RDPのクリップボード制御はKOKOの写真・動画アップロードを禁止する設定ではありません。[セッションの継承](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)、[AccessのMFA設定](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)

2026-09-28のローカル確認ではNode.js `24.16.0`／npm `11.13.0`で、`apps/api`から`npm.cmd --prefix ../.. run build:api`を実行し成功しました。最初の実行は環境のプロセス起動制限（`spawn EPERM`）で止まり、制限外の再実行で型生成整合性とdry-run buildが成功しました。依存関係の新規導入、CloudflareのLinux上のbuild、実deploy、Accessの動作はこの結果に含みません。

根拠：[Workers Builds設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[ビルド環境と変数](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)、[WorkersのAccess保護](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)。

#### 課金の区分

R2の開始画面にはサブスクリプション確認があり、無料枠を超えた使用量は課金されます。アカウント作成だけとR2有効化を区別してください。[R2開始手順](https://developers.cloudflare.com/r2/get-started/)

Workers Paidの最低額は5 USD/月。QueuesはFreeにも10,000 operations/日がありますが保持は24時間です。Paidでは100万operations/月を含み、超過は100万あたり0.40 USD。通常の1メッセージ配送は書込・読込・削除の3操作で、再試行も増分です。[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[Queues料金](https://developers.cloudflare.com/queues/platform/pricing/)

R2は保存量・操作数、Streamは保存枠・配信分数の課金です。動画の秒数だけで総費用を判断しません。[R2料金](https://developers.cloudflare.com/r2/pricing/)、[Streamの丸めと比較](cost-policy.md#streamの課金単位)

### 3. Supabase：DB・認証

1. [Supabase Dashboard](https://supabase.com/dashboard)でアカウントと管理用Organizationを準備します。
2. 接続開始時に開発用プロジェクトを1つ作ります。リージョンは日本からの利用とCloud Runとの距離・費用を確認して決めます。データ所在に関する組織ルールがあれば先に教えてください。
3. DBパスワードは十分強いものを設定し、パスワード管理ツールへ保存します。既存migrationはCodex側で適用手順を検証してから使います。今すぐSQL Editorへ貼り付ける必要はありません。
4. Google OAuthの準備時にAuthenticationのGoogle provider画面を開き、そこに表示されたSupabase callback URLをGoogleへ登録します。Client ID／Secretはそのprovider画面へ入力します。詳細は次のGoogle Cloud節を参照してください。
5. アプリのSite URLとredirect許可リストは、実際の開発URLが確定してから設定します。任意ドメインを許可する広いwildcardで代用しません。Google以外のログイン手段は今回追加しません。

Freeは開発の候補ですが、非活動7日でのpauseやbackup制約があります。Proは25 USD/月から、10 USDのcompute creditでMicro 1台分を含みます。追加プロジェクトのcomputeは別計上です。日次backupはProで7日保持。本番の復旧要件を確認してプランを選びます。[Supabase料金](https://supabase.com/pricing)、[Google連携](https://supabase.com/docs/guides/auth/social-login/auth-google)

### 4. Google Cloud：OAuth・画像変換・Vision

1. [Google Cloud Console](https://console.cloud.google.com/)で管理者・プロジェクトを準備します。既存の大学／実行委員会の契約を使える場合は、管理者の許可と請求先を先に確認してください。
2. Cloud RunやVisionの利用開始時に請求先を関連付けます。アカウントの所有者・請求者によるカード登録や本人確認は、ご自身で行う必要があります。[Cloud Run準備](https://docs.cloud.google.com/run/docs/setup)
3. 後続でCloud Run、Artifact Registry、build方法に応じたCloud Build、Vision APIを有効にします。公開サービスや広い権限を持つサービスアカウント鍵を先に作らないでください。コンテナ・最小権限・サービス間認証は実装と合わせて用意します。
4. GoogleログインはGoogle Auth PlatformでBranding／Audience／Data Accessを設定します。一般来場者を対象にするため、大学内限定のInternal設定を安易に使いません。アプリ名・問い合わせ先・公開主体は運営側が確定します。最小scopeは`openid`、`email`、`profile`です。
5. テスト段階では必要なGoogleテストユーザーを登録します。Web applicationのOAuth clientを作り、Authorized JavaScript originsへ確定したアプリorigin、Authorized redirect URIsへSupabase画面から取得したcallback URLを登録します。アプリの`/auth/callback`とSupabaseのcallbackを取り違えないでください。公開への切替・審査の要否は管理画面で確認します。[Supabase公式のGoogle設定手順](https://supabase.com/docs/guides/auth/social-login/auth-google)

Cloud RunのCPU・メモリ・通信、コンテナ保管・build・ログは使用量次第です。Visionは画像ごと・機能ごとの課金で、SafeSearchとOCRを1機能分とは数えません。各機能の最初の月1,000単位は無料、その後500万単位までText Detectionは1,000単位あたり1.50 USD、SafeSearch単独も1.50 USDです。動画3フレームや再試行の回数を含めます。[Vision料金](https://cloud.google.com/vision/pricing)

通常のAlerts-only予算は通知用であり支出を止めません。Spend cap予算は別機能で、Preview条件と対象サービス・停止時の影響の確認が必要です。どの通知／停止方式を使うかを確認せず、自動停止済みとは扱いません。[Google Cloud予算](https://docs.cloud.google.com/billing/docs/how-to/budgets)

### 5. OpenAI API：モデレーション

1. [OpenAI API Platform](https://platform.openai.com/)でアカウントとKOKOの管理用プロジェクトを準備します。管理主体と請求・使用制限を設定できる担当者を確認してください。
2. 実接続の段階で、用途を限定したプロジェクトのAPIキーを用意します。組織管理用Admin APIキーをアプリに使いません。値はBEのSecretへ入力し、Webの`NEXT_PUBLIC_`変数やブラウザには渡しません。[公式quickstart](https://developers.openai.com/api/docs/quickstart)
3. 必須の画像判定には採用済みの`omni-moderation-latest`を用います。現時点のModeration endpointは無料ですが、実アカウントの利用可能状態・rate limitとエラー時の処理は別に検証します。無料だから無制限・常時成功とは扱いません。[公式Moderationガイド](https://developers.openai.com/api/docs/guides/moderation)

実ユーザーの画像送信や課金操作は今回行っていません。違法・機微なサンプルの収集や送信は、通常の動作確認のために行わないでください。

## 節約案と判断の順序

以下は比較候補であり、有料プランの採用決定ではありません。USD、税・為替別。クラウド利用量は未測定のため、総額や請求削減額はまだ提示できません。

| 案                                     | メリット                                | デメリット・作業負担                                             | 判断                             |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| 今はローカル＋モックを継続             | 今回の機能検証にクラウド料金・鍵が不要  | 実ログイン・保存の検証は後になる                                 | 今回の承認済み範囲               |
| 開発のみ無料枠、本番前に必要なプランへ | 未使用期間の固定費を抑えられる          | pause・quota・移行時の再確認が必要。連携・復旧条件の確認工数あり | 接続前に可否を確認               |
| 本番用の安定性を先に確保               | backup・quota・共同管理を早く検証できる | Vercel席数、Supabase project数等に固定費。未利用期間も課金       | 本番負荷と管理人数を確認して選ぶ |
| 既存管理ドメインのsubdomainを使う      | 新規ドメインの購入・更新を省ける可能性  | 既存管理者の承認・DNS設定・障害範囲の確認が必要                  | 所有・利用権限がある場合だけ比較 |

3.8／3.5／3.0秒の比較は[費用方針](cost-policy.md)に従います。3.8秒から3.5秒へ短縮しても、Streamの丸めにより請求額が変わらない場合があります。必須AI、認証、原本保持を省いて節約しません。

次の費用比較では、同じ開催期間の低／標準／高負荷について、投稿数×動画比率×実duration、保存日数・bytes、視聴回数と上流取得数、CPU時間、AI機能数・再試行、管理人数を入力にします。総費用は「プラン／席／projectの固定費＋各サービスの課金量×単価（無料枠・丸め反映）＋税等」。工数単価は未定なので、移行・保守の時間を架空の金額へ換算しません。

予算の上限が未定でも実装は進められます。ただし、有料接続前に「まず通知する金額」「通知を受ける人」「異常時に自動停止するか」を決めましょう。上限なしの承認として無通知で資源を増やすことはしません。

## Codex側で行うこと／人間が行うこと

- Codex：接続設定のひな型、migration手順、最小権限の構成案、アプリ・CI、秘密を使わない検査、費用試算と比較。実クラウド操作は対象・権限の承認後。
- 人間：アカウントの本人確認、支払・契約主体、組織招待の承認、秘密の入力、公開・審査・法務判断、実機のカメラ操作、最終レビュー。

準備ができたサービスから、非秘密のID・URLを基に接続作業を具体化します。5社すべての準備完了を待たずに、まずSupabase＋Google OAuthの設定を確認できます。
