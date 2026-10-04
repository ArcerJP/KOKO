# クラウドの役割と準備ガイド

**配備作業の最新記録は[2026-10-03の障害・権限修正・停止状態](#2026-10-03の配備障害と再発防止)です。** 以下の日付付き履歴を現在の設定と混同せず、再開時は[api-deployment Skill](../../.agents/skills/api-deployment/SKILL.md)に従って現物を再確認します。

確認日：GitHub Actionsの初回手動配備・通常main更新による自動配備と配備後の応答・保護確認は2026-10-01〜02、Cloudflare Workerの初回build・deploy成功と未認証アクセスの転送確認は2026-09-29、保存済みAccess設定の閲覧確認は2026-09-28〜29、専用トークンの作成・保存とBuilds登録成功のユーザー報告、Zero Trust Free有効化とWorker作成フォームの画面確認は2026-09-28、Vercelの初回配備・保護設定とCloudflareアカウント・R2の初期準備は2026-09-23、その他の準備・料金情報は2026-09-22。対象はB1-1〜B1-3の準備です。採用構成の正本は[プロダクト構成](../architecture/product-architecture.md)、費用判断の方針は[費用方針](cost-policy.md)です。確認済みの範囲は各節に記載し、全サービスの契約・課金・実連携や本番受け入れの完了とは区別します。

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

上表の「今回の実装」は当初のローカル検証段階を指し、現在の外部設定の完了状況ではありません。現在地は[項目別の進捗](#項目別の進捗2026-10-02更新)と下記の各サービス記録を参照してください。

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

2026-10-02、Vercel `arcer2/koko-web`にSupabase KOKO用の`NEXT_PUBLIC_SUPABASE_URL`と`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`をProductionのみへ保存し、一覧で登録名と適用先を確認しました。後者は`sb_publishable_`形式の公開用キーで、全文は本書へ記録しません。同じ操作中に適用先を誤変更した既存の`HUSKY`と`NEXT_TELEMETRY_DISABLED`は、iijimaが元の値`0`／`1`と元の適用先Production＋Previewを確認したうえで復元しました。両方ともSecret種別を維持し、保存前の入力値と保存後の適用先を確認しています。Secretの値は保存後に読み返していません。Vercelは変更の反映に新しいデプロイが必要と表示しました。この時点で再デプロイやGoogleログイン試験は行っていません。

その後、Googleログイン実装のPR #14がmainへマージされ、保護を維持したVercel Productionの配備成功を確認しました。未ログインで`/account`へアクセスすると`/login`へ転送され、iijima提供の画像ではGoogleログイン後の`/account`にログイン状態が表示されました。ログアウト完了はiijima本人の報告です。これは本人1件の認証導線の確認であり、投稿・閲覧API、同意・表示名、他人の認可、一般公開の検証完了ではありません。

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
- 2026-09-28〜29の初期構築では、Workers Builds用の専用User API Token `koko-api-dev-build`について、iijimaから作成・保存完了の報告を受けました。承認済みの範囲はKOKOで使用するCloudflareアカウント1件の`Workers:Admin`、TTLは2026-09-28開始・2026-10-19終了でした。対象アカウント・権限・期間は発行後の要約画面でも確認し、秘密の値は閲覧・取得・記録していません。初回Worker作成後は継続配備に必要な権限へ限定する方針とし、未使用サービスの権限は先行付与しません。Buildsへの登録と一覧照合は本人実行ログ`RESULT=REGISTERED_AND_VERIFIED`、既存トークン選択は承認済みの画面再読み込み・入力復元後に確認しました。注意表示の内部判定の原因は未確定ですが、このトークンによる初回ビルドのdeploy成功を確認しています。その後は既存トークンを編集する案ではなく、個別Worker限定の新資格情報とActionsへ移行しました。旧トークン削除の本人報告と現在の進捗は[下記](#項目別の進捗2026-10-02更新)を参照してください。[トークン作成と変更](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[Workersの権限](https://developers.cloudflare.com/workers/authorization/workers/)
- Worker基盤は`apps/api/`に実装し、`GET /health`、開発用R2 binding、ローカルテスト、dry-run buildを追加しました。型検査・テスト・buildのGitHub Actionsも実行成功を確認しています。2026-09-28〜29のユーザー提供画像と読み取り専用確認により、Cloudflare上の`koko-api-dev`作成、`ArcerJP/KOKO`の`main`への接続、本人操作による初回Build `41b7ab63`の開始、その後のbuild・deploy成功を確認しました。所要時間は5分39秒で、2026-09-29の画面ログに`Success: Deploy command completed`と`Success! Build completed.`が表示されました。配備先は[開発API](https://koko-api-dev.arcer-jp.workers.dev/health)、R2 bindingは`ORIGINALS_BUCKET`と`DERIVED_BUCKET`です。初期化中の概要ではURL無効・Bindings 0でしたが、完了ログではURLと2つのbindingが報告されました。同日、本人から認証後の動作確認完了の報告と、固定URLの`/health`に`{"service":"koko-api","status":"ok"}`が表示された画像を受け取りました。認証情報やセッションは取得していません。実R2読書きは未検証です。ビルド成功・API応答・bindingの配備・R2実接続検証を区別します。必須checkの導入順序は[CI規約](../ci.md#新しい必須checkを導入する順序)を参照してください。

#### 残る準備

1. Workers、R2、Stream、Queuesは別々の課金項目です。Webサイト向けの「Pro」契約と「Workers Paid」も別です。
2. B1-1の残りとして、開発専用Workers、Queues、Streamを本番資源と分離して準備します。資源名・プラン・保持期間は作成前に確認します。
3. R2の`r2.dev`公開とPublic custom domainを有効にしません。Streamは常時署名必須です。Bucket Lockは削除できない期間を作るため、保持期間の合意前には設定しません。
4. 接続時には対象資源を限定した資格情報を用意し、Global API Keyをアプリに使いません。値はSecretストアへ設定します。
5. 開発用APIをCloudflare Accessで保護する方針は承認済みです。2026-09-28、初回の許可対象はiijima本人のみとし、共同開発者は後から追加する方針をiijimaが承認しました。本人を識別するメールアドレス1件も確認・承認済みです。値は公開文書へ記載せず、メールドメイン全体やCloudflareアカウントの全メンバーを許可する設定と混同しません。Zero Trust Freeの有効化とWorker作成フォームでの選択に続き、初回ビルド開始後のWorkerのAccessタブで`Worker Access All traffic`、本番・Previewの全URLでログイン必須、`koko-dev-iijima-only`、承認済み本人メール1件の`Allow`を確認しました。2026-09-29の配備後、固定URLの`/health`へCookie・認証情報なし、リダイレクト追従なしでGETし、HTTP 302でCloudflare Accessログイン先へ転送されることを確認しました。最初の検査はローカル実行環境の接続制限で失敗し、制限外の読み取り専用再実行で確認しています。その後、本人の認証後の正常応答を本人報告と画像で確認しました。配備一覧のリンクから取得したVersion URL 3件（現行`a40d491f`、旧版`f2833009`・`82d3e774`）の`/health`も、同じ未認証条件でGETし、いずれも302でAccessへ転送されました。認証方式・MFAの実効設定、許可対象外の認証済み利用者の拒否試験は未確認です。全URL保護の設定と、実際に試した固定URL・3つのVersion URLの保護動作を区別します。KOKO利用者向けのGoogleログインとは別の開発用アクセス制御であり、このデプロイ用トークンへAccess管理権限を追加するものではありません。[WorkersのAccess保護](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

##### 項目別の進捗（2026-10-02更新）

上の番号は順番に完了するチェックリストではなく、準備作業と継続して守る条件が混在しています。現在は「2のWorkers配備とAPI応答確認、4のWorker限定資格情報によるActions初回手動配備・受入確認、旧トークン削除の本人報告と自動配備有効化、通常main更新による自動実行・配備後確認、5の本人限定Access設定・認証済み正常応答・固定URLと試験したVersion URLの未認証アクセス制限」まで進んでいます。自動配備の確認結果は[下記の記録](#2026-10-02の通常main更新による自動配備)を参照してください。Cloudflare全体の準備完了ではありません。

| 残る準備                           | 現在の状態                                                                                                      | 次の確認・作業                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1：課金の区分                      | R2・Zero Trust Freeに加え、Queuesの無料枠とStream最小保存枠1,000分・月額5 USDの有効化を確認                     | 配信従量料金・利用量を確認。通知を支出上限と扱わない                    |
| 2：開発専用Workers・Queues・Stream | Worker配備、空のQueue 2件（保持24時間・consumerなし）、Stream最小枠の有効化まで確認                             | Queue接続・Stream処理実装。実R2読書きの検証は別途                       |
| 3：非公開化・署名・保持            | R2は非公開。Streamは有効化済みだが動画未投入で、動画ごとの署名必須設定・検証は未実施                            | R2非公開を維持。Stream投入時に署名必須、保持期間合意前はBucket Lockなし |
| 4：限定した資格情報                | 開発APIの配備経路を移行確認済み。Worker限定資格情報で手動／自動配備・配備後確認。旧トークン削除は本人報告       | 期限前の資格情報更新。将来接続する他サービスの資格情報は別途準備        |
| 5：本人限定Access                  | 自動配備後もAll traffic・本人限定policy・認証済み正常応答を確認。固定URLと新Version URLの未認証GETはAccessへ302 | 認証方式・MFAの実効設定、認証済み対象外利用者の拒否試験                 |

開発APIの配備経路については、移行手順6の自動実行と配備後確認まで進みました。残るAccess検証・実R2読書きを未完了項目として保持し、Queues・Streamは下記の資源準備まで進んでいます。新資格情報の期限前更新も必要です。初回ビルドのやり直しは不要です。設定変更・権限変更・失効操作は対象ごとに承認を確認し、勝手に実行しません。

##### 2026-10-02のQueues・Stream準備

iijimaは通常用`koko-dev-media`と失敗退避用`koko-dev-media-dlq`の作成、およびStream最小保存枠1,000分・月額5 USDと配信従量料金による有効化を承認しました。対象は空の資源準備までで、動画投入、Worker接続・配備、新資格情報の作成、既存トークンの権限拡大は含みません。

- **Queues：作成済み。** 作成前に空の一覧と無料枠10,000操作/日を確認し、上記2件を作成しました。各SettingsでMessage retention `86400 seconds`（24時間）、Delivery delay `0 seconds`、`No consumers configured`を確認しました。一覧は2件とも`Inactive`、メッセージ・操作数は0です。Workers producerは接続せず、既定のHTTP Push表示だけを確認しています。DLQ用の名前を付けただけでは失敗転送は有効にならず、後続のconsumer設定と失敗復旧試験が必要です。[Queues料金](https://developers.cloudflare.com/queues/platform/pricing/)、[DLQ設定](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- **Stream：最小枠の有効化済み。** iijimaが規約同意・毎月課金許可と`Activate`を操作し、有効化完了を報告しました。同日の確認画面で`Purchase complete`、`The subscription is active`、通常のImages & Stream基本枠0 USD、動画保存1,000分・月額5 USD、動画配信1,000分あたり1 USDを確認しました。Imagesの有料保存、Starter/Creator Bundle、追加保存枠は含めていません。AIは購入確定を代行せず、支払情報も記録していません。動画投入・署名設定・実連携の成功とは区別します。[Stream料金](https://developers.cloudflare.com/stream/pricing/)
- Worker、R2、Access、配備トークン、既存のBudget Alertは変更していません。原本の削除・保持・Bucket Lockも未変更です。Streamの動画ごとの署名必須設定、source/clip処理、Queue配送は未実装・未検証として残します。資源準備をB1-1全体やメディア処理の完了とは扱いません。

2026-09-29、iijimaは、`koko-api-dev-build`を対象Worker `koko-api-dev`だけの`Editor`へ縮小し、対象アカウントと期限2026-10-19を維持すること、および登録作業が終わった`koko-builds-register-once`の失効を承認しました。ただし、既存User API Tokenをそのまま個別Worker限定へ編集できるという当初案は、後述のトークン種別とBuildsの対応制限を考慮していませんでした。この案での権限縮小は未実施です。Buildsでは編集済みトークンが古い状態として扱われる場合もあり、新規発行・再登録・再配備を自動で進めません。[Buildsの古いトークンに関する注意](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#stale-api-token)

同日の編集画面では、既存トークンの`Account → Workers`の権限候補は`Admin`のみで、対象の種類も`Account`・`Zone`・`User`でした。個別Workerと`Editor`を指定する項目は確認できず、権限やTTLを変更・保存せず一覧へ戻りました。アカウント全体の旧`Workers Scripts: Edit`は個別Worker限定の代わりにはならず、無断で採用しません。この時点の配備用トークンは対象アカウント1件の`Workers:Admin`と期限2026-10-19のままでした。後続の新資格情報への移行と旧トークン削除は、下記の日付付き記録を参照してください。

同日、iijimaの承認を受け、設定変更なしで別経路を調査しました。公式文書はWranglerの資源単位権限に**Account API Token**を指定しています。実際の`Manage account → Account API tokens`の作成画面でも、`Specified Workers`とWorkersの`Editor`を確認しました。既存User API Tokenの編集画面とは別の経路です。ただし、Workerの選択・権限の入力・トークンの発行は行っておらず、この資格情報による実配備も未検証です。未保存で一覧へ戻り、Account API Tokenが未作成の状態を確認しました。[Wranglerでの資源単位権限](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler)、[Account API Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

**Workers Buildsは同日の公式文書上、配備用トークンとしてUser API Tokenだけに対応し、Account API Tokenは未対応です。** Builds管理APIも別途User API Tokenを要求するため、登録API経由でAccount API Tokenを持ち込めるとは判断しません。[Buildsの配備用トークン制限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)、[Builds管理APIの認証](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)

個別Worker限定を優先する代案は、対象`koko-api-dev`だけのWorkers `Editor`を持つAccount API Tokenを新たに用意し、APIの配備をGitHub Actions等の外部CIから既存Wranglerで行う構成です。Worker・R2・Access・Vercelを作り直す案ではありません。別Workerへの権限を除ける利点がある一方、配備workflow、Secret管理、Buildsとの二重配備防止、期限更新の保守が増えます。対象Workerの更新権限やbinding経由のデータへの影響までなくなるわけではありません。公式の対応経路に基づく提案であり、KOKOでの動作保証ではありません。[GitHub Actionsからの公式配備手順](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

その後、iijimaは具体的な移行計画の作成を承認し、通常運用は「初回検証後、mainへのマージで自動配備」を選択しました。2026-09-29に計画案を作成し、続けて「外部設定を変更しない配備の仕組み・テスト・文書のローカル実装」まで承認を受けました。workflow・実行ガード・回帰試験・文書をローカルへ追加し、CI相当の検証を完了しました。同日、commit・push・PR作成まで追加承認を受けました。初期の自動配備OFF、導入PRのmerge前のBuilds切断、本人の手動受入、旧トークン失効、その後の自動化という順序は下記にまとめます。このローカル実装・PR作成の許可に、発行、Secret登録、Builds切断、Actionsでの配備、旧配備用トークン失効は含まれません。後続の本人による準備状況は下記で区別し、PR作成やCI成功を外部適用済みと扱いません。

補助用`koko-builds-register-once`は削除直前の一覧で`Expires soon`でした。画面の失効手段が`Delete`のため、復元できないことと配備用トークン・Workerを削除しないことを説明し、iijimaから「補助用トークンだけ削除してよい」と実行時点の承認を受けました。同名の削除確認ダイアログを照合して実行し、削除後の未絞り込み一覧から補助用が消え、配備用だけが残ることを確認しました。補助用トークンは復元できません。配備用の編集保存、Builds設定変更、再登録、再配備は行っていません。

#### 2026-10-03の配備障害と再発防止

##### 原因と検証済みの範囲

以前のGitHub Actions配備は成功していました。最初に失敗したのは、DashboardでSupabase設定を保存した後、Wranglerが配備前に追加で読むmetadataの権限です。Worker本体の消失やSupabaseキー不良を示す証拠ではありません。権限修正後の単回配備では、この段階を通過して別の設定差分チェックで停止しました。下記の最新結果と区別します。

| 段階            | 確認した事実                                                                                                        | 根拠                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 変更前          | 10月2日のActions配備はWrangler 4.145.0で成功                                                                        | [API Deploy #5](https://github.com/ArcerJP/KOKO/actions/runs/37004973191)                       |
| Dashboard更新後 | 10月3日のSupabase設定保存後、更新元がDashboardのVersion `a794ecf8`を100%配信。続く4.145.0の配備はmetadata取得で失敗 | 管理画面の読取り確認、[API Deploy #6](https://github.com/ArcerJP/KOKO/actions/runs/37101002506) |
| 版更新          | 4.147.0へ更新しても同じmetadata取得失敗。版更新だけでは解消しなかった                                               | [API Deploy #7](https://github.com/ArcerJP/KOKO/actions/runs/37105605539)                       |
| 原因の絞込み    | 同じGitHub Environmentの資格情報で`routes`と`custom_domains`だけHTTP 403・code 10000、他5GETは200                   | [診断 #1](https://github.com/ArcerJP/KOKO/actions/runs/37110013506)                             |
| 限定修正の検証  | 本人承認でMetadata Read-Onlyを追加後、同じmain・同じ診断の7GETすべて200 / OK、`ALL_METADATA_READS_OK`               | [診断 #2](https://github.com/ArcerJP/KOKO/actions/runs/37111614952)                             |
| 単回配備の結果  | 権限修正後のmetadata取得は通過。R2設定の差分を`--strict`が検出し、upload前に停止。Active Versionは変更なし          | [API Deploy #9](https://github.com/ArcerJP/KOKO/actions/runs/37115832750)                       |

Wrangler 4.147.0の[配備前処理](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.147.0/packages/deploy-helpers/src/deploy/helpers/validate-worker-props.ts)では、`last_deployed_from === "dash"`のときにリモート設定を取得します。[取得処理](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.147.0/packages/deploy-helpers/src/deploy/helpers/download-worker-config.ts)はbindings・routes・custom domains等を読み、どの取得失敗も共通のmetadataエラーとして表示します。実診断の`deployment_source=dash`と権限変更前後の403→200が、この原因判断の根拠です。会話履歴が見えなくなったことがCloudflare設定を変更したという証拠はありません。

以前の成功を根拠に「以後も同じ権限で十分」と判断し、失敗APIを特定する前にWrangler更新へ進んだことが切り分けを長引かせました。以後は、Dashboard変更後も通る読取り診断を先に確認し、失敗箇所の証拠なしに版更新・権限拡張・キー再入力を繰り返しません。

##### 承認・保存済みの権限と期限

`koko-api-dev-deploy`の既存tokenを編集し、次の2policyを保存・再表示で確認しました。新規発行・秘密値の再登録はしていません。

- 書込み：既存の`koko-api-dev`1件だけに`Individual Workers Editor`。
- 追加読取り：対象アカウントのWorkers全体に`Metadata Read-Only`。現在・将来の別Workerの設定や観測データにも及ぶため、本人が承認した限定修正であり、個別Workerだけの読取りとは説明しない。

公式仕様では、この読取りroleにソースコード・Secret値の閲覧は含まれませんが、ログ等に機微な内容があれば閲覧リスクは残ります。R2・Access・D1等の管理権限やWorkers Adminは追加していません。現時点の公式仕様ではCustom Domainsはper-Worker role未対応です。この2policyは今回の診断成功を示すもので、将来の全配備の必要十分条件を保証しません。[CloudflareのWorkers権限](https://developers.cloudflare.com/workers/authorization/workers/)、[追加決定](../decisions/ADR-0003-worker-scoped-deployment.md#2026-10-03の追加決定)

期限は本人の希望する日本時間10月20日に合わせ、保存予定JSONの`expires_on=2026-10-19T23:59:59Z`（JST 10月20日08:59:59）を確認し、承認後に1回保存しました。開き直した画面は終了日10月20日、上記2policy・IP条件は維持されています。これは保存操作とUIの再確認であり、この最終保存後のAPIによる実失効時刻の再検証ではありません。以前の9月29日には、同じUTC/JST時刻を本人のverify結果で確認済みです。

日付のみの表示、保存予定payload、保存済み時刻は区別します。今回、権限保存前後で終了日表示が20日→21日となった理由をタイムゾーンだけと断定する証拠はありません。既存の期限記録を先に読み、表示差だけを理由に繰り返し保存・再発行しません。

##### 停止状態と次の受入

2026-10-03 19:10〜19:31 JSTの単回配備と再確認です。継続時は現物を再確認してください。

- `KOKO_API_AUTO_DEPLOY_ENABLED=false`。本人承認で一時停止し、GitHubの実行中・待機中status 5種は各0件。**手動`API Deploy`はOFFでも配備するため、診断と取り違えない。**
- mainはPR #17を含む`836189e5b376b55bc90bd6054ea586a172a154a7`。読取り診断の実装は反映済み。
- WorkerのProductionへ`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`を本人が入力・保存し、登録名を確認済み。値は取得・文書化していない。
- 期限調整後の[読取り専用診断 #3](https://github.com/ArcerJP/KOKO/actions/runs/37113946832)は、同じmainで7GETすべて200 / OK。その後、本人がmainの既存Workerへの実配備1回を承認した。
- [API Deploy #9](https://github.com/ArcerJP/KOKO/actions/runs/37115832750)を19:15:48 JSTに1回だけ起動し、attempt 1で19:17:05にfailure。Verificationは成功したが、Wrangler 4.147.0の`--strict`が`r2_buckets`の設定差分を検出し、upload前に停止した。再実行・strict解除・強制上書き・rollbackはしていない。
- 配備前にR2 binding 2件、Access All trafficと本人限定、既存Secret名3件、旧Builds未接続を確認。停止後もActive `a794ecf8`・100%・Dashboard更新元のままで、Version Historyに新しい版はない。完全Version IDは非公開タスク記録へ保存した。
- 停止後にAccess All trafficと本人限定を再確認。固定URLとActive Version URLの`/health`は、Cookie・認証情報なし、リダイレクト追従なしのGETで、いずれも既知のCloudflare Accessログイン先へHTTP 302となった。認証後healthの今回の再試験は未実施。
- GitHubの停止後確認でもauto deploy=false、実行中・待機中status 5種は各0件、mainは同じSHA。EnvironmentはBranch型mainだけ、既存Secret名2件・Environment variablesなし。tokenの2policyも維持されている。
- 新しいmainの外部適用、配備後の`/me`とSupabase接続受入、自動配備の再開は未完了。後続のローカル調査・提案検証は下記に記録。追加配備は別承認とする。

#### R2設定差分と読取り診断の追加（2026-10-03）

[API Deploy #9](https://github.com/ArcerJP/KOKO/actions/runs/37115832750)はmain `836189e5b376b55bc90bd6054ea586a172a154a7`の検証成功後、Wrangler 4.147.0のR2設定差分チェックでupload前に停止しました。metadata取得を通過した後の別の停止条件です。この時点では新mainは未配備で、自動配備OFF・Access保護・既存Active Versionを維持しました。修正後の実配備結果は[10月4日の記録](#r2修正後の単回配備2026-10-04)を参照してください。

配備ログの差分は`r2_buckets`内の空オブジェクト2件で、変更対象の値が表示されませんでした。Dashboard上のbinding名・bucket名はローカル設定と一致しています。これだけで実際のBucket変更やデータ破損とは判断しません。

固定版4.147.0の[metadata変換](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.147.0/packages/workers-utils/src/map-worker-metadata-bindings.ts)はR2に`jurisdiction`を無条件で追加し、[比較処理](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.147.0/packages/deploy-helpers/src/deploy/helpers/config-diffs.ts)へ渡します。同じインストール済み比較処理のオフライン再現では、リモート側だけに`jurisdiction: undefined`があると、削除差分・`nonDestructive=false`となり、今回と同じ空の差分表示になりました。単なる配列の並び順では差分なし、空文字の場合は値の差分が表示されました。

本人承認後、比較処理だけでなくAPI形式の模擬bindings → 実metadata変換 → 設定生成 → 比較まで通して追跡しました。R2の`jurisdiction`がAPIデータにないと、変換処理が`jurisdiction: undefined`を作り、ローカルの未指定との差が`jurisdiction__deleted: undefined`になります。`json-diff`はundefined値を文字列表示しない一方、strict判定は削除として扱います。このソフトウェア上の不具合を再現し、#9の実ログにある空オブジェクト2件と一致することを再確認しました。

当初は実環境のbindings応答の`jurisdiction`有無が未確認でした。その後、2026-10-03 23:35 JSTの[読取り診断 #4](https://github.com/ArcerJP/KOKO/actions/runs/37130145092)で`r2Count=2`、`expectedPairsMatch=true`、`ORIGINALS_BUCKET`と`DERIVED_BUCKET`各1件・接続先一致・両方`jurisdiction=ABSENT`を確認しました。7GETすべて200 / OK、配備元はdashです。固定版の不具合再現と実環境の発生条件が一致しました。**この時点では実環境の条件照合まで完了し、修正後の実配備成功は未検証**でした。

最初の最小修正案は上流のR2 metadata変換1箇所に限り、`jurisdiction !== undefined`の場合だけ同項目を設定するもので、実適用せずメモリ内で24件の試験に成功しました。同一設定の空差分は解消し、Bucket/Binding名変更・削除、設定済みjurisdictionの変更・削除、別bindingやrouteの削除は破壊的差分のままです。空文字/nullを未設定扱いにはせず、`wrangler.jsonc`へ空文字を追加する案では現行strictエラーが残ることも確認しました。今回の局所実装はこの結果を基にし、実バンドルの回帰と適用ガードを29件の公開試験へ統合しています。

実環境で最後の照合を行うため、既存[読取り診断](../../.github/scripts/api-diagnose.mjs)にR2の件数・期待した接続先との一致・jurisdictionの有無等の固定分類だけを出す変更を追加しました。Secret値・未知の名前/値は表示せず、通信は同じ7GET、workflow・権限・配備処理は変更しません。実装と分類の正本は[CI規約](../ci.md#配備metadataの読取り専用診断)です。[PR #18](https://github.com/ArcerJP/KOKO/pull/18)はローカル全CI相当検査（266件、E2E 7件）とGitHub CI 5 workflow・13 jobの成功後、22:21 JSTに本人がmergeしました。その後、方針文書の[PR #19](https://github.com/ArcerJP/KOKO/pull/19)も本人がmergeし、診断 #4はmain `d5700de32112498233c469321b9a446b2ca16de8`で1回だけ実行しました。

診断 #4は本人採択の[継続承認](../../AGENTS.md#作業進行と承認境界)に基づき、[api-deployment](../../.agents/skills/api-deployment/SKILL.md#2-変更前後の読取り診断)の安全条件を現物確認して実行しました。自動配備OFF、Environment main限定、同名Environment variableなし、競合runなし、既存Secret名・R2・Access All traffic/本人限定・Builds未接続・tokenの既存2policyと期限表示10月20日を確認し、入力/保存はしていません。Activeはa794ecf8・100%・Dashboard更新元のままです。

2026-10-03の再調査で[npm公式配布のlatest](https://registry.npmjs.org/wrangler/latest)は4.147.0、[上流mapper](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-utils/src/map-worker-metadata-bindings.ts)にも同じ無条件追加が残っていました。このため固定4.147.0への限定互換修正を技術判断として採用し、APIのbuild/deploy前に版・適用前後hashを検証して適用する実装を追加しました。依存追加・lockfile更新・Worker設定変更はありません。独自修正の保守が必要なため、対象不一致では停止し、公式修正版を検証できた時点で解除します。[実行・検証・解除手順](../ci.md#wrangler-r2未指定値の限定互換修正)を正本とします。根拠なしの版更新、strict解除、権限追加やSupabaseキー再入力は採用しません。

この限定修正は[PR #20](https://github.com/ArcerJP/KOKO/pull/20)で本人がmergeしました。その後、対象SHA・Worker・復旧対象・実行回数を確認し、個別承認された[10月4日の単回配備](#r2修正後の単回配備2026-10-04)は成功しました。`/me`の外部接続受入の範囲は下記の配備後記録を参照してください。自動配備は再開していません。

履歴として、19:52 JSTの前段調査ではmainは当時のSHA、自動配備false、実行中・待機中5種は各0件でした。管理画面のActive a794ecf8・100%、Access All traffic・本人限定も維持されていました。この時点では追加配備・実診断・クラウド設定変更を行っていません。

22:24 JSTのPR #18 merge後照会ではmainが同PRのmerge SHAへ進み、自動配備false、Environment main限定・同名Environment variableなし、実行中/待機中5種各0件を確認しました。その照会ではCloudflareの管理画面を再確認せず、追加配備・実診断・クラウド設定変更も行っていません。現在の診断・Active/Access等の観測は上記23:35 JSTの記録と区別します。

繰り返す実行順序・停止条件は[api-deployment Skill](../../.agents/skills/api-deployment/SKILL.md)に集約します。会話中断後は、本文と現物を照合し、承認済み変更・未実施操作・次の本人判断をタスク記録に残します。診断は手動の運用ゲートであり、CIが配備前に必ず自動実行する仕組みを追加したわけではありません。新しい仕様変更や別原因の障害まで防止を保証しません。

#### R2修正merge後の配備前確認（2026-10-04）

00:20:26 JST、PR #20がmain `404b7e147780ef1ec7164020639766d0d934ae34`へmergeされ、GitHub作業ブランチが削除されたことを確認しました。merge内容はPRで検証済みのtreeと同一です。[merge後のAPI Deploy](https://github.com/ArcerJP/KOKO/actions/runs/37132899236)はVerification成功・Deploy skippedであり、修正を適用したdry-runまでの成功です。実配備完了ではありません。

00:25 JST、上記mainで[読取り診断 #5](https://github.com/ArcerJP/KOKO/actions/runs/37133201127)を継続承認の安全条件に従い1回実行し、attempt 1で成功しました。7GETすべて200 / OK、配備元dash、R2は期待する2件と一致・両方jurisdiction=ABSENTです。新しいmainで診断条件を再照合しましたが、upload成功やSupabase受入の証明ではありません。

配備前の現物確認では、Active a794ecf8・100%・Dashboard更新元、ProductionのSupabase Secret名3件、R2 binding2件、Access All traffic・本番/Preview全URL保護・本人限定、Builds未接続を維持しています。復旧用の完全Version IDは管理画面のView logsに表示されたfilterで再照合し、非公開タスク記録へ保存しました。固定URL/当該Version URLのhealthは、Cookieなし・redirect非追従で既知のAccessログイン先への302を確認。tokenの既存2policy・期限表示10月20日・IP条件も変更ありません。

自動配備false、Environmentはmain branchのみ・同名Environment variableなし、診断前は配備待機/実行中5種各0でした。ローカルの配備/診断/互換回帰190件も成功。この配備前確認の時点では、新たなログイン、秘密入力、設定/権限変更、実配備、自動配備再開は行わず、既存koko-api-devへの1回の適用について個別確認待ちとしました。

#### R2修正後の単回配備（2026-10-04）

本人がmain `404b7e1`から既存`koko-api-dev`への1回の配備と配備後確認を個別承認しました。直前にmain full SHA・自動配備OFF・Environment main限定・同名Environment variableなし・競合runなし・同SHA診断 #5成功を再照合し、00:35:40 JSTに既存`API Deploy`をmainで1回だけ手動起動しました。

- [API Deploy #13](https://github.com/ArcerJP/KOKO/actions/runs/37133792641)：attempt 1、SHA `404b7e147780ef1ec7164020639766d0d934ae34`、Verification・Deployともsuccess。00:36:57 JSTに完了。
- 配備ログでWrangler 4.147.0、限定互換修正`PATCHED`、uploadとtrigger配備の成功を確認。`--strict`を解除せず、以前のR2偽差分による停止を通過しました。
- 新Version `b6f0d26d`がActive・100%・Wrangler更新元となり、全9versionへ1件増加。管理画面のView logsに表示される完全Version IDをログと照合し、一致しました。旧版と新しい完全IDは非公開タスク記録に保持しています。rollback・再配備は行っていません。
- 固定URLと新Version URLの`/health`をCookieなし・redirect非追従でGETし、いずれもHTTP 302、既知のAccessホストと各対象ホストのログインパスへの転送を確認。
- 配備後もProductionのSupabase Secret名3件・暗号化表示、R2 binding2件と既存接続先、Access All traffic・本番/Preview全URL保護・本人限定、旧Builds未接続を確認。秘密値の取得や権限・設定の変更はしていません。
- 00:38 JSTのGitHub再照会でもmainは同一SHA、自動配備false、Environment main限定・変数なし、実行/待機中5種各0。自動配備は再開していません。

**実配備・未認証保護・認証後healthの受入を確認しました。** 当初、既存Chromeで固定URLを開くとAccessログイン画面になったため、新規ログインは代行せず本人へ引き渡しました。その後、本人から「health正常」と回答を受け、案内した`{"service":"koko-api","status":"ok"}`の確認完了として記録しています。認証後の応答は本人報告であり、Codexによる独立した再読取りとは区別します。`/me`実装はこのSHAに含まれますが、外部Workerと実Supabaseを使う接続受入は別途未完了です。DB書込み・正式イベント作成・実R2読書き・他資源の全体監査は実施していません。health正常は自動配備再開の承認ではなく、自動配備OFFを維持します。

続く本人のCloudflare Access CLI認証成功後、既存のアプリ認証を利用した読取りで固定URLのhealth200と期待JSONを独立確認しました。固定URLと新Version URLの匿名GETは引き続き既知Accessへの302です。正しい形式の`X-Event-ID`を付けた外部`GET /me`は、Bearerなし・不正Bearerとも401・`AUTH_REQUIRED`となり、応答契約も照合しました。キー・JWT・Cookie・個人情報は出力・記録していません。これは開発Accessの通過と未認証拒否の確認であり、この段階では正規Google JWTでのSupabase所属照会は本人Googleログイン待ちでした。mainは文書PR #21反映後の`42bc0a9`、自動配備false、配備runの実行/待機なしを再確認し、追加配備・アプリDB書込み・Access設定変更は行っていません。

同日、本人がローカルのマスク入力とGoogleログインで読取り試験を実行し、`RESULT=CLOUD_READ_ONLY_AUTH_DB_VERIFIED`と`TEST_SESSION_SIGN_OUT=OK`を報告しました。この成功判定は、上記の保護・health・401検査に加え、実Google JWTの本人確認と、外部Workerの`GET /me`がランダムな未所属イベントに403・`FORBIDDEN`を返すことを照合した場合にだけ出力されます。**開発Worker・実Supabaseを結ぶ読取り／未所属拒否経路の受入は成功**です。根拠は本人実行の結果であり、Codexがキーや実JWTを取得して再実行したものではありません。試験用Googleセッションのsign-outも成功していますが、Cloudflare Accessの認証キャッシュ削除や全端末のログアウトを示すものではありません。

今回アプリテーブルへの書込みはなく、正式イベント・所属・規約同意は作成していません。クラウド側の所属あり`GET /me`正常応答・`PATCH /me`更新、別実アカウントの境界、全テーブルRLS、Cookie／CSRF、Next.js画面、メディア実接続は未検証または未実装です。ローカルWorkerで確認済みの正常系と、今回の外部読取り／拒否系を混同しません。追加配備・権限/Secret/Access変更・自動配備再開は行っていません。

#### WebからのAccessサービス認証の準備（2026-10-04、実設定未適用）

Webサーバーの固定API中継へ、サーバー専用資格情報を付与するローカル処理を追加しました。[設定条件と本人ゲート](../../apps/web/README.md#accessサービス認証ローカル実装実設定未適用)、[選定理由](../decisions/ADR-0005-web-access-service-auth.md)を参照してください。合成資格情報での検証であり、実service tokenの発行・登録、Access policyの追加/変更、Web/Worker設定・DB変更、実配備・有効化・接続受入を実施した記録ではありません。

同日21:40 JSTのGitHub読取り確認ではmain `d420509`、`KOKO_API_AUTO_DEPLOY_ENABLED=false`、[API Deploy](https://github.com/ArcerJP/KOKO/actions/runs/37202834155)はVerification成功/Deploy skip、実行中・待機中の配備0件でした。既存Access設定は変更していません。この確認からCloudflare管理画面の設定やアプリ受入を新たに検証済みとは扱いません。

#### GitHub Actionsへの移行手順（外部操作は別途承認）

以下は9月29日〜10月2日の移行履歴・初期設定案です。継続運用では[10月3日の追加権限と停止状態](#2026-10-03の配備障害と再発防止)を先に確認してください。

2026-10-02時点では、PR #11のmergeとmainのpushによる検証成功・配備skip、Actionsからの初回手動配備と受入確認、旧トークン削除の本人報告、自動配備フラグ`true`の本人提供画像に続き、PR #13のmergeによる自動配備と配備後の応答・保護・設定維持を確認しました。移行手順6までの確認結果と残る検証範囲を下記へ記録します。採用理由は[ADR-0003](../decisions/ADR-0003-worker-scoped-deployment.md)、実行条件と自動テストは[CI規約](../ci.md#開発用api配備)を参照してください。下表は移行時の設定案であり、設定済みの一覧ではありません。

| 項目                | 設定案・保存先                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 対象                | 既存の開発用Worker `koko-api-dev`のみ。Worker・URL・R2・Accessは維持                                                  |
| 新資格情報          | `koko-api-dev-deploy`というAccount API Token。対象アカウント1件、Specified Workersで当該Worker1件、Workers Editorのみ |
| 期限                | 発行前に再確認。提案上限は2026-10-19。発行日と画面の終了日・APIのUTC失効日時を照合し、無期限にしない                  |
| GitHub Environment  | `koko-api-dev`を管理者が事前作成。Deployment branches and tagsはBranch型の`main`だけ。Tagは追加しない                 |
| Environment Secrets | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。実値は本人が入力し、ログ・Git・チャット・成果物へ残さない            |
| Repository variable | `KOKO_API_AUTO_DEPLOY_ENABLED`。移行時は`false`、受入後だけ`true`。同名Environment variableを作って値を上書きしない   |
| 実行先              | 標準GitHub-hosted Linux runner。専用・有料runnerや追加課金の申込みなし。適用前に利用条件を確認                        |

2026-09-29の準備状況（本人の報告・提供画像に加え、保存後の画面とGitHub APIを読取り確認。Codexによる外部設定変更は未実施）：

- 保存後のEnvironment `koko-api-dev`の画面で、`Selected branches and tags`、Branchの`main`1件・Tag 0件、Required reviewersとWait timerがOFFであることを独立確認しました。管理者bypassは初期表示のONのまま変更していません。
- 同じEnvironmentのSecret一覧で`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`の名前2件、Environment variablesが空であることを確認しました。Repository variablesも再読込みし、`KOKO_API_AUTO_DEPLOY_ENABLED=false`を確認しました。Secret値は取得・表示しておらず、実値の正しさと新トークンによる配備は未検証です。
- このフラグは新しいActions経路の自動配備だけを制御します。既存Buildsの停止や手動配備の禁止を意味しません。旧Buildsの切断状況は下記で区別し、導入PRのmerge・初回手動配備・自動化は別段階として扱います。
- 本人から、現在の操作者は本人のみで、切替中は案内する操作以外のmainへのpush・PR mergeを一時停止できると回答を受けました。これは運用上の合意であり、GitHubの保護設定変更やBuilds切断の実行承認ではありません。
- 停止前の読取り確認では、Active Deploymentは既存の`a40d491f`を100%配信中でした。対応する成功Buildのログと照合し、完全Version IDを非公開の作業記録へ記録しました。Build historyは全1件・成功済みだけで、実行中・待機中の表示はありません。PR #11はopen・Draft・未mergeで、headは従前のまま、必須13検査は全件successでした。mainも従前のSHAから変わっていません。
- 下記の本人によるAPI確認結果で、新トークンの実際の失効時刻を照合しました。その後、本人提供画像でBuild historyが成功済み1件のみであることと、対象WorkerのSettings → BuildsのGit repository欄が`Connect`だけの未接続表示になったことを確認しました。Codexが切断を代行したわけではなく、再読込後の維持を独立確認した記録とは区別します。`Connect`による再接続は行いません。[Buildsの切断](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds)
- 同時点のGitHub API再確認ではPR #11はopen・Draft・未merge、headとmainは従前のまま、必須13検査とVercel Preview Commentsはsuccessでした。現headへの承認レビュー1件について、iijimaから「別の共同開発者に確認してもらった」と回答を受け、レビュー担当者が本人か不明という保留理由は解消しました。再照会でも同じheadへの承認と検査成功・未mergeを確認しました。[Git運用ルール](../../.agents/skills/git-workflow/SKILL.md#pushとpr作成のアカウント一致)に従い、切断後の未接続表示の維持と自動配備フラグ`false`を確認したうえで、本人がDraftを解除し、GitHub上の通常の承認・検査条件を満たしてmergeする手順を案内しました。管理者bypassや保護ルール変更で回避せず、Codexは承認・mergeを代行しません。この時点ではPR merge・Actions実配備・旧トークン失効・自動配備有効化は未実施でした。

2026-09-30の移行状況：

- 本人からDraft解除完了の報告を受け、マージ前にGitHubの保存済みRepository variables画面を読取り確認しました。`KOKO_API_AUTO_DEPLOY_ENABLED`は`false`、Environment variablesは空でした。設定は変更していません。
- 続く本人提供画像とGitHub APIにより、[PR #11](https://github.com/ArcerJP/KOKO/pull/11)のmergeを確認しました。merge commitは`4c2e1bdd16ad8dde5df0c55f2254cb7447f0bd59`で、照会時のmain先頭と一致しています。[API Deploy #1](https://github.com/ArcerJP/KOKO/actions/runs/36597022463)はこのSHAの`push`で起動し、`API Deploy Verification`は`success`、`API Deploy to Development`は`skipped`、run全体は`success`でした。これは検証だけの成功で、新しい資格情報による実配備の成功ではありません。
- この時点で次の作業として、main更新停止と旧Builds切断を維持し、自動配備フラグを`false`のまま、本人が`Run workflow`で`main`を選び1回だけ手動実行する手順を案内しました。手動経路はフラグOFFでも検証成功後に既存Workerを更新します。失敗・タイムアウト時は再実行や権限拡大をせず、Active Deploymentと失敗箇所を確認します。

2026-10-01の初回手動配備（実行は本人、確認は読取り専用）：

- 本人提供画像では`main`・`4c2e1bd`の`workflow_dispatch`が`Queued`でした。その後のGitHub API照会では[初回手動実行](https://github.com/ArcerJP/KOKO/actions/runs/36869672802)のattempt 1が完了し、`API Deploy Verification`と`API Deploy to Development`が両方`success`でした。対象SHAは`4c2e1bdd16ad8dde5df0c55f2254cb7447f0bd59`です。Codexは追加実行・キャンセル・設定変更をしていません。
- 配備jobのログで`Uploaded koko-api-dev`、`Deployed koko-api-dev triggers`、固定URLが従前と同じであること、新Version `948956fd-558c-4210-9f33-4735e7ab204e`を確認しました。R2 bindingも`ORIGINALS_BUCKET`→`koko-dev-originals`、`DERIVED_BUCKET`→`koko-dev-derived`と報告されています。ログ上の配備成功と、管理画面のActive Deployment照合・実R2読書きは区別します。
- 配備後の固定URLの`/health`へCookie・認証情報なし、リダイレクト非追従でGETし、HTTP 302と既知のCloudflare Accessログイン先への転送を確認しました。最初のローカル接続確認は失敗し、制限外の読取り専用再確認で成功しています。認証情報・応答Cookie・リダイレクトのクエリ値は出力や文書へ含めていません。
- この時点では本人認証後の正常応答、新Version URLのAccess保護、管理画面のActive Deployment・保存済みbinding・Access policy・旧Builds未接続の維持は未照合でした。続く確認結果を下記へ記録します。

2026-10-01〜02の追加受入確認（外部設定の変更なし）：

- 本人から配備後の「health正常」の報告を受けました。提供画像とCloudflareのDeployments画面で、ログの新Versionに対応する`948956fd`がActive Deploymentとして100%配信されていることを確認しました。本人の認証済み応答は本人報告、配備状態は管理画面の読取り確認として区別します。
- 配備一覧に表示された新Version URLの`/health`へCookie・認証情報なし、リダイレクト非追従でGETし、HTTP 302と、従前と同じAccessログイン先・対象Versionホストのログインパスを確認しました。ローカル接続制限による失敗後、制限外の読取り専用再確認で成功しています。先に確認した固定URLと合わせ、今回の配備でも保護が維持されています。応答Cookie・リダイレクトのクエリ値は出力・保存していません。
- Access画面で`Worker Access All traffic`、本番とPreviewの全URLでログイン必須、`koko-dev-iijima-only`、承認済み本人メール1件の`Allow`を確認しました。Settingsの保存済みR2 bindingは`ORIGINALS_BUCKET`→`koko-dev-originals`、`DERIVED_BUCKET`→`koko-dev-derived`の2件で、Git repositoryは`Connect`だけの未接続表示でした。Recent buildsは従前の成功Buildだけで、今回のActions配備に伴う新規Builds配備は表示されていません。
- 以上と既存の保存済みトークンpolicy・期限確認を合わせ、移行手順4の初回手動受入を確認しました。確認範囲は対象Worker・配備ログ・保存済み設定であり、アカウント全資源の監査、実R2読書き、認証方式・MFAの実効設定、対象外の認証済み利用者や別Workerへの拒否試験は実施していません。今回の読取り確認では他資源の変更・データ投入をしていません。
- この受入確認後、2026-10-02に本人から旧`koko-api-dev-build`はこのWorkerの旧Builds以外では使用していないと回答を受けました。用途確認だけを削除の実行承認や完了記録とは扱わず、下記の本人操作へ進みました。

2026-10-02の旧トークン整理（本人操作）：

- 本人提供のUser API Tokens削除確認画面で、対象名が旧`koko-api-dev-build`であることを確認しました。復元不可であること、新`koko-api-dev-deploy`・GitHub Secret・Worker本体は対象外であることを明記し、本人に削除と一覧再読込みの手順を案内しました。その後、本人から一覧で「消えていました」と報告を受けました。移行手順5の完了を本人報告として記録し、Codexによる独立した削除後一覧照会や旧秘密値による無効化試験を実施したとは扱いません。
- 手順6として、本人に既存Repository variable `KOKO_API_AUTO_DEPLOY_ENABLED`を`false`から小文字の`true`へ変更・保存し、一覧で値を確認する手順を案内しました。同名Environment variableの追加、Secret変更、Builds再接続は対象外です。

2026-10-02の自動配備有効化（本人操作）：

- 本人から「trueにできました」と報告を受け、提供画像のRepository variables一覧で`KOKO_API_AUTO_DEPLOY_ENABLED`の値が`true`であることを確認しました。これは本人報告と提供画像による有効化の確認であり、Codexが設定変更・保存後の独立した再照会を行ったわけではありません。
- 有効化時点では自動実行は未実証でした。設定保存だけで過去のpushは再実行されないため、次の必要な変更を通常のPRレビュー・mainへのmergeで反映し、両jobの成功と受入条件を確認する手順を案内しました。本人の承認により作成した移行記録の文書更新PR #12は、その確認候補でしたが、先行して必要になった依存脆弱性修正の別PR #13により、下記のとおり自動実行を確認しました。PR作成やPRのCI成功を自動配備の実証とは扱わず、空commitや手動再実行も代用していません。

##### 2026-10-02の通常main更新による自動配備

- [PR #13](https://github.com/ArcerJP/KOKO/pull/13)は2026-10-02 01:24:48 JSTにmerge済みで、main先頭は`6d425f15e0140691e7a3def62aa144a7dd1d2be7`でした。[API Deployの自動実行](https://github.com/ArcerJP/KOKO/actions/runs/36891798633)は、このSHAの`push`を契機に起動し、attempt 1の`API Deploy Verification`と`API Deploy to Development`が両方`success`でした。手動実行や配備skipではありません。
- 配備jobのログでWrangler `4.145.0`、`Uploaded koko-api-dev`、`Deployed koko-api-dev triggers`、Version `0b234e2f-70e8-4ed7-9a78-adfb06d98e64`を確認しました。CloudflareのDeployments画面でも対応する`0b234e2f`がActive Deploymentとして100%配信されていました。Cloudflare側の`Manually deployed / Wrangler by Unknown`という表示だけで起動元を判断せず、GitHubのイベント・SHA・配備ログのVersionと照合しています。
- 既存の認証済みブラウザで固定URLの`/health`を再読込みし、`{"service":"koko-api","status":"ok"}`を読取り確認しました。以前の本人報告や再読込み前の表示の流用ではありません。新たなログイン、認証情報・Cookieの取得、Accessの迂回は行っていません。
- 固定URLと、配備一覧のリンクで取得した新Version URLの`/health`を、Cookie・認証情報なし・リダイレクト非追従でGETしました。両方ともHTTP 302で、既知のAccessログインホストと各対象ホストのログインパスへ転送されました。応答Cookie・クエリ値は出力・保存していません。
- 保存済みSettingsのR2 binding 2件（`ORIGINALS_BUCKET`→`koko-dev-originals`、`DERIVED_BUCKET`→`koko-dev-derived`）、Git repositoryの`Connect`だけの未接続表示、Accessの`All traffic`と本人限定policyを照合しました。Recent buildsは従前の成功Build `41b7ab63`だけで、自動配備に伴う新しいBuilds配備は表示されていません。
- 以上により、通常main更新による自動実行と、確認対象の応答・保護・設定維持を実証しました。新資格情報の保存済みpolicy・期限は先の確認記録を根拠とし、今回秘密値を取得して再検証したわけではありません。実R2読書き、別Workerへの拒否試験、全アカウント資源の変更監査、認証方式・MFAの実効設定、対象外の認証済み利用者の拒否試験は未実施です。全サービスの準備や本番受入の完了とは扱いません。

当時のPR #12は、上記の結果を反映する文書更新でした。脆弱性修正はPR #13の変更です。当時は文書だけのmain更新でも自動配備が起動するため、配備結果を確認できる時間帯でのmergeを案内しました。現在の自動配備フラグは最新記録と現物で確認してください。

Environmentが既にあれば、Secret値は再表示せず、用途・保護・同名変数の衝突を確認してから進めます。既存設定の上書き、reviewerの削除、Repository/Organization Secretsへの代替登録は行いません。通常はmainのPRレビューを承認境界とするため、新たな毎回のEnvironment reviewerは設けない案ですが、既存reviewerがあれば確認します。main限定の保護を設定する前にworkflowを手動実行しないでください。

2026-09-29の本人提供のAccount API Token作成画面では、Permission policiesの選択肢に`Start from scratch`、Token expirationに`Custom`、確認ボタンに`Review token`が表示されています。`Start from scratch`からの入力後、`Specified Workers`で`koko-api-dev`1件、`Individual Workers`の`Editor`だけ選択済みであることを確認しました。期限欄は`9/29/26 - 10/19/26`、IP/CIDR欄は空です。続く発行前Summaryの提供画像では、名前`koko-api-dev-deploy`、終了日`October 19, 2026`、policyはWorkersの`koko-api-dev`に対する`Individual Workers Editor`1件、IP制限は`All IP addresses allowed`であることを照合しました。計画と一致するため、本人へ`Create token`による発行と暗号化された保管先への保存を案内し、その後、本人から「作成・保存完了」と報告を受けました。Codexは秘密の値を閲覧・記録していません。

同日、保存済みトークンの詳細を入力・保存せず閲覧し、名前と対象Worker1件・`Individual Workers Editor`1 policy、IP/CIDR空欄を独立確認しました。期限欄は`9/29/26 - 10/20/26`と表示され、発行前Summaryの`October 19, 2026`と日付が異なったため、切断前に実際の失効日時を確認することにしました。本人は発行後の変更について「変更していないはずだが、よく覚えていない」と回答し、変更履歴は断定していません。

続いて本人が、保存済みトークンを伏せ字入力して公式のAccount API Token verifyをGETで実行しました。提示された結果は対象token ID照合を含む`RESULT=CHECKED`、`TOKEN_STATUS=active`、`EXPIRES_UTC=2026-10-19T23:59:59.0000000+00:00`、`EXPIRES_JST=2026-10-20T08:59:59.0000000+09:00`でした。これにより実際の期限は**UTCの2026-10-19 23:59:59（日本時間2026-10-20 08:59:59）**と確認しました。UTCと日本時間で日付が異なることと画面表示は整合し、実際の期限が不明という保留理由は解消しました。画面内部の表示処理や過去の変更履歴を検証したわけではありません。[確認API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)

この期限確認でCodexは秘密値の取得・token verify照会の代行をしていません。この結果だけではGitHub Secretに同じ値が保存されていることや、Worker配備が成功することの検証にはなりません。この時点では期限の再設定・トークン再発行・旧配備用トークン削除・実配備は行っていませんでした。後続の旧Builds停止・導入PRのmerge・本人によるActions配備と受入確認は、上記の日付付き記録を参照してください。

Client IP address filteringは、標準GitHub-hosted runnerから使うため今回の入力案ではIP/CIDRを空欄とし、本人のPCのIPは指定しません。GitHubは標準runnerの広いIP範囲をallowlistに使うことを推奨しておらず、範囲も更新されます。空欄ではIPによる制限がないため、トークンの漏洩時には他の場所からも権限範囲内で使用され得ます。Worker限定・期限・Environment Secretの保管を守り、発行前に確認します。固定IP方式への変更は別途構成判断とします。[GitHubのrunner IP](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#ip-addresses)、[Cloudflareのトークン制限](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)

1. **ローカル変更のレビュー・PR準備**：外部設定や実配備を含まない差分と検証結果を確認。通常のcommit・push・PRは[継続承認の条件](../../TOOLS.md#web操作の利用条件)を照合し、対象ファイルとbranchを通知してGit-E-z7で実施。PRのレビューとmergeは人間が担当し、この時点ではまだmergeしない。
2. **移行先の準備**：実行時点で対象・期限・保管先の承認を取り、上表のEnvironment・フラグ・新資格情報を準備。対象Worker1件とEditorを選べなければ発行せず停止。Account API TokenをBuildsへ登録しない。
3. **旧経路の停止**：初回作業中はmain更新を止める時間帯を合意。正常なActive Deploymentの完全Version IDを記録し、実行中・待機中Buildがないことを確認して、対象WorkerのSettings → Builds → Disconnectだけを承認後に実施。設定・履歴削除を伴う画面なら、その影響も確認。Worker削除やGitHub App全体の解除はしない。
4. **初回の手動受入**：旧経路の切断を再読込で確認した後に本人が導入PRをmerge。pushで検証だけが動き、deployがOFFであることを確認してから、本人が`API Deploy`を`main`で1回手動実行。下記の受入を行う。
5. **旧資格情報の整理**：受入合格後、旧`koko-api-dev-build`を他で使用していないことを確認。元User API Tokenの失効を別途承認後に実施。復元不可の削除は対象を再確認し、Builds側の登録名削除だけで代替しない。
6. **自動配備の有効化**：受入と旧トークン失効の後に、別途承認を受けてRepository variableを`true`へ変更。次の必要な変更を通常どおりPRレビュー・mainへmergeし、自動配備を確認。検証のための空commitは作らない。

導入PRのmergeより前に旧Buildsを止め、2経路からの配備を避けます。GitHub側のconcurrencyではBuildsからの配備を制御できません。自動配備を有効にしただけでは過去のpushは再実行されず、「有効化済み」と「自動実行の実証済み」を区別します。

##### 初回と自動化後の受入

- tokenの保存済み書込policyが対象Worker1件のEditorだけ・期限ありで、読取policyも[承認済みの構成](#承認保存済みの権限と期限)に一致することを確認。未承認の追加policyや書込範囲拡大を除外。
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
- 期限更新はiijimaが担当する案です。現在の承認済みpolicyとUTC/JSTの期限を確認し、後継資格情報が必要なら承認後に発行。Environment Secret更新→読取り診断→配備受入→旧資格情報失効の順。無断延長・自動更新用の強い資格情報・Global API Keyは使いません。詳細は[配備Skill](../../.agents/skills/api-deployment/SKILL.md#3-secretと期限の取扱い)を参照します。

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
3. DBパスワードは十分強いものを設定し、パスワード管理ツールへ保存します。初期migrationはKOKO開発DBへ適用済みです。同じSQLを再適用せず、後続の変更もmigration履歴を確認してから進めます。SQL Editorへ初期SQLを貼り付けません。
4. Google OAuthの準備時にAuthenticationのGoogle provider画面を開き、そこに表示されたSupabase callback URLをGoogleへ登録します。Client ID／Secretはそのprovider画面へ入力します。詳細は次のGoogle Cloud節を参照してください。
5. アプリのSite URLとredirect許可リストは、実際の開発URLが確定してから設定します。任意ドメインを許可する広いwildcardで代用しません。Google以外のログイン手段は今回追加しません。

Freeは開発の候補ですが、非活動7日でのpauseやbackup制約があります。Proは25 USD/月から、10 USDのcompute creditでMicro 1台分を含みます。追加プロジェクトのcomputeは別計上です。日次backupはProで7日保持。本番の復旧要件を確認してプランを選びます。[Supabase料金](https://supabase.com/pricing)、[Google連携](https://supabase.com/docs/guides/auth/social-login/auth-google)

### 4. Google Cloud：OAuth・画像変換・Vision

1. [Google Cloud Console](https://console.cloud.google.com/)で管理者・プロジェクトを準備します。既存の大学／実行委員会の契約を使える場合は、管理者の許可と請求先を先に確認してください。
2. Cloud RunやVisionの利用開始時に請求先を関連付けます。アカウントの所有者・請求者によるカード登録や本人確認は、ご自身で行う必要があります。[Cloud Run準備](https://docs.cloud.google.com/run/docs/setup)
3. 後続でCloud Run、Artifact Registry、build方法に応じたCloud Build、Vision APIを有効にします。公開サービスや広い権限を持つサービスアカウント鍵を先に作らないでください。コンテナ・最小権限・サービス間認証は実装と合わせて用意します。
4. GoogleログインはGoogle Auth PlatformでBranding／Audience／Data Accessを設定します。一般来場者を対象にするため、大学内限定のInternal設定を安易に使いません。アプリ名・問い合わせ先・公開主体は運営側が確定します。最小scopeは`openid`、`email`、`profile`です。
5. テスト段階では必要なGoogleテストユーザーを登録します。Web applicationのOAuth clientを作り、Authorized JavaScript originsへ確定したアプリorigin、Authorized redirect URIsへSupabase画面から取得したcallback URLを登録します。アプリの`/auth/callback`とSupabaseのcallbackを取り違えないでください。公開への切替・審査の要否は管理画面で確認します。[Supabase公式のGoogle設定手順](https://supabase.com/docs/guides/auth/social-login/auth-google)

2026-10-02、iijimaの指定でGoogle Cloudプロジェクト`KOKO`（ID `koko-510318`、親は「組織なし」）を作成し、管理画面で確認しました。無料トライアル・請求先は設定していません。Google Auth Platformにはアプリ名`KOKO`、外部ユーザー、本人が公開を了承したサポートメール、および同じ開発者連絡先を入力し、iijima本人がユーザーデータポリシーに同意して初期構成を作成しました。Web用OAuth client `KOKO web development`には固定Web URLをJavaScript origin、Supabase KOKOプロジェクトのcallbackをredirect URIとして登録し、管理画面の作成通知と一覧で確認しました。Data Accessには`openid`、メールアドレス、基本プロフィールの3スコープのみを保存し、本人1件をテストユーザーとして登録しました。公開ステータスは「テスト中」のままです。Client Secretは閲覧・記録せず、サポートメールの値や認証情報も本書へ記録しません。

同日、iijimaがGoogle Client ID・SecretをSupabase KOKOプロジェクトのGoogle providerに入力して保存しました。保存前の画面でClient IDが作成済みWeb用IDと一致し、GoogleログインはON、`Skip nonce checks`と`Allow users without an email`はOFF、callback URLはGoogleへ登録したものと一致することを確認しました。Secretはマスク表示で存在のみ確認し、値の一致は確認していません。保存後の一覧では`Google Enabled`を確認しました。これはprovider設定の保存確認であり、ログイン成功ではありません。初期状態のSupabase Site URLは`http://localhost:3000`、redirect許可リストは空でした。固定Web URLは未ログインのブラウザーからアクセスした際にVercelのログイン画面へ転送されました。このためSite URLの変更と一般公開は保留しました。WebのGoogle OAuth開始・callback・Google単独セッション確認は作業ブランチにローカル実装しましたが、公開用キーを設定した実ログインとアプリ全体の認証ゲートは未検証・未実装です。

続いてiijimaは、Supabase KOKOのRedirect URLsへ`https://koko-web-green.vercel.app/auth/callback`の1件だけを追加し、Email providerを無効化することを承認しました。管理画面で`Successfully added 1 URL`と許可リストの1件表示、`Email Disabled`と`Google Enabled`を確認しました。Site URLは`http://localhost:3000`のまま、Vercelの閲覧保護も変更していません。この時点ではローカルcallback URLは未登録でした。これらは認証設定の保存確認であり、Webの実ログイン成功や公開用キーの配備確認ではありません。

2026-10-03、実JWTと開発DBを使うローカル試験のため、iijimaの承認を受けてRedirect URLsに正確な`http://localhost:3000/auth/callback`を追加しました。管理画面で既存の公開Web用URLと合わせて2件を確認しています。ワイルドカード・Site URL・公開範囲は変更していません。この追加時点では実JWT・DB・Workerの結合試験前でした。

同日の試験では、自動操作用ChromeでGoogleログインが拒否されました。[Google公式の対応ブラウザー案内](https://support.google.com/accounts/answer/7675428)に従い、通常のChrome／Edgeで本人が手動ログインし、承認済みのlocalhost callbackで[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)の認証結果を受け取るローカル試験へ変更しました。試験用コードはGit対象外の`tmp/`に置き、キー・JWTはファイルに保存せず、試験セッションのみ終了時にサインアウトします。ローカル受信処理の試験とダミーキーでの起動確認は成功しました。この補助試験はNext.js画面そのものの検証を含みません。

手動ログイン用ページの初回送信では、補助コードの`Referrer-Policy: no-referrer`によりフォームの`Origin`が`null`となり、送信元チェックに拒否される不具合をChromeで再現しました。ログインページだけを`same-origin`に変更し、送信元・Cookie・CSRFの検証を維持しました。フォーム転送先のCSPには当該SupabaseとGoogle認証のoriginを明示しています。修正後は受信処理4試験と、実ChromeによるPC内の疑似認証・callback・Cookie消去の1試験が成功しました。これは実Googleログインの成功を示すものではありません。[Referrer-Policyのブラウザー仕様](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)

続く本人の実行結果では、`SIGNED_GOOGLE_JWT=VERIFIED`、`SIGNED_JWT_EVENT_QUERY=200`、`TEST_SESSION_SIGN_OUT=OK`を確認しました。一方、ローカル`/me`は認証なし・不正Bearer・実JWTで順に401／500／500となり、結合試験全体は停止しました。ダミーキーだけのローカルWrangler診断で、workerdが`redirect: "error"`を受け付けず例外になることを再現しました。

本人の承認後、`apps/api/src/account.ts`の認証・DB通信の2か所を`redirect: "manual"`へ修正しました。自動追従せず、既存の非2xx拒否で転送もエラーにするため、Bearerや秘密キーを転送先へ送りません。[Cloudflareの転送時の注意](https://developers.cloudflare.com/workers/runtime-apis/request/)に沿った方針です。テストの疑似通信でもworkerdの`Request`生成を通し、修正前は24件中17件が失敗、修正後は24件すべて成功しました。認証先・DBの301／302／303／307／308拒否、認証なし・不正Bearerの401、所属なしの403を含みます。型検査・対象ESLint・dry-run buildも成功し、ローカルWranglerからダミーキーを用いた実通信で不正認証への401を確認しました。この修正直後は実JWTによる`/me`再試験待ちでした。DB書き込み、commit、push、merge、外部配備は行っていません。

続く2026-10-03の本人提供ログと完了画面では、`SIGNED_GOOGLE_JWT=VERIFIED`、`SIGNED_JWT_EVENT_QUERY=200`、ローカル`/me`の認証なし401・不正Bearer401・所属のない実JWT403、`PUBLIC_APP_TABLE_WRITES=NONE`、`RESULT=READ_ONLY_AUTH_DB_VERIFIED`、`TEST_SESSION_SIGN_OUT=OK`を確認しました。これにより、実Google認証・開発DB・ローカルWorkerを結ぶ読み取り／拒否経路は成功です。これは実アカウント1件の試験であり、全テーブルのRLS、所属ありの`/me`正常応答・表示名更新、規約同意保存、Next.js画面の通し試験、外部配備の確認ではありません。キー・JWT・利用者IDは文書へ記録していません。

同日、iijimaは開発DBへの専用draftイベント1件・本人の一般ユーザー所属1件の一時保存、`/me`取得・表示名変更・未同意状態の試験、試験行だけの限定削除を承認しました。補助処理について、正常・通信断・誤対象・片付け失敗・復旧・metadata検査の模擬15試験、既存OAuth補助4試験、API24試験、ダミーキーでの補助サーバー起動確認が成功しました。実行前に既存DBパスワードでcatalogだけを読み、テーブル/RLS・独自トリガー・ルール・危険なFK削除設定などを確認する構成です。一時行をcommitし、最後に本人所属→専用イベントの順で削除して残存0と削除後403を検証します。中断時は試験イベントIDだけのローカル復旧記録を使用し、作成の成否不明・対象不一致・削除未確認では停止します。DBログ等までの抹消を保証するものではありません。

続く本人提供ログで、実Google JWTの検証、所属あり`GET /me`の200と`consent_required=true`、表示名`PATCH /me`の200と再取得一致、無関係イベント403を確認しました。`CONSENT_WRITES=NONE`、試験イベント・所属・同意の残存がそれぞれ0、削除後403、`CLEANUP=VERIFIED`、`RESULT=MEMBERSHIP_AUTH_DB_VERIFIED_AND_CLEANED`、試験セッションsign-out成功も確認しました。ローカルの復旧記録・実行ロックが残っていないことも照合しました。**実Google JWT・開発DB・ローカルWorkerでの本人情報正常系と試験データの限定削除は成功**です。証拠は本人実行ログであり、Codexが実キーを取得して再実行したものではありません。正式イベント・所属や規約同意は登録しておらず、別実アカウント・全テーブルRLS・Next.js画面の通し試験・クラウド配備は未完了です。試験完了時点ではcommit・push・merge・外部配備は未実施でした。実試験の成功とPR反映・外部配備は別の工程です。

2026-10-02の読み取り専用事前確認では、Supabase KOKOプロジェクトの`public`テーブルは0件、移行履歴も初回実行前で、Freeプランにはプロジェクトバックアップがありませんでした。[初期SQL](../../apps/api/supabase/migrations/20260921000000_initial_contract.sql)のPGlite試験はローカルで10件成功しました。

その後、iijimaが対象と単一の保留migrationを事前確認し、Supabase CLIで`20260921000000_initial_contract.sql`をKOKO開発DBへ適用しました。提示された実行結果では、適用後のローカル・リモート移行履歴は`20260921000000`で一致し、`public`テーブル14件、RLS有効14件、public policy 7件です。リモートのSQL Editorで同じスキーマを再実行しません。

同日、iijimaの承認を受け、実DBのSQL Editorで`BEGIN`～`ROLLBACK`による認可試験を実施しました。事前確認では認証ユーザー1件、イベント・所属0件、対象2テーブルのユーザー定義トリガー0件でした。既存ユーザーのIDだけをSQL内部で参照し、一時イベントと所属を挿入。`SET LOCAL ROLE`と`request.jwt.claim.sub`の模擬設定で、本人のイベント・所属読取は成功、別IDの読取は0件、匿名ロールのイベント読取は権限エラー、`service_role`の読取は成功しました。匿名への読取権限や認証利用者への直接書込権限・投稿読取権限がないことも確認しました。試験後の別クエリでは認証ユーザー1件、イベント・所属0件、public policy 7件で、一時データが残っていないことを確認しました。IDの値、メールアドレス、パスワードは表示・記録していません。これは**実DBでロールとIDを模擬したRLS試験**であり、署名済みJWTを使うWeb/API経由の認可、別の実アカウント、全14テーブルの全操作を検証したものではありません。[SupabaseのRLS試験手順](https://supabase.com/docs/guides/database/postgres/row-level-security)

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
