# クラウドの役割と準備ガイド

確認日：2026-09-22。対象はB1-1〜B1-3の準備です。採用構成の正本は[プロダクト構成](../architecture/product-architecture.md)、費用判断の方針は[費用方針](cost-policy.md)です。この文書は契約・課金・配備の完了記録ではありません。

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

1. [Vercel](https://vercel.com/signup)でアカウントを準備し、管理するTeamとメンバーを確認します。
2. GitHub連携時は、GitHub Organizationの管理者がVercel GitHub Appを承認します。対象を`ArcerJP/KOKO`に限定し、無関係なリポジトリへ権限を広げません。
3. プランはまだ確定しません。Hobbyは個人・非商用向けです。さらに公式[Git連携説明](https://vercel.com/docs/git#using-hobby-teams)は「Organization内のprivate repositoryは不可」、[制限説明](https://vercel.com/docs/limits#connecting-a-project-to-a-git-repository)は「Organizationのrepositoryは不可」と記載が一致していません。KOKOはPublicですが、Hobbyで接続できると断定せず、実際の連携画面と利用条件を一緒に確認してから決めてよいですか？
4. 「Import／Deploy」は初回配備につながるため、今は押す必要がありません。後続で`apps/web`をRoot Directoryにし、外側の共有契約を含めるmonorepo設定とビルド順を検証してから接続します。現在のCI成功はVercel配備成功の証拠ではありません。

Proは月額20 USDのplatform feeにdeploy可能な1席と20 USDの従量creditを含み、追加のdeploy席は各20 USD/月、閲覧専用席は無料です。超過利用や追加機能は別料金です。Hobbyの可否と複数人のdeploy要否を確認して、不要な席を増やさないのが節約案です。[Pro公式料金](https://vercel.com/docs/plans/pro-plan)、[Hobby条件](https://vercel.com/docs/plans/hobby)

### 2. Cloudflare：API・保存・動画・処理待ち

1. [Cloudflare Dashboard](https://dash.cloudflare.com/)でアカウントを準備します。自分のWebサイトや独自ドメインの登録は、アカウント準備の前提にしません。
2. Workers、R2、Stream、Queuesが別々の課金項目であることを確認します。Webサイト向けの「Pro」契約と「Workers Paid」は別です。
3. 後続のB1-1で、開発専用Workers、原本用と派生物用の2つの非公開R2バケット、Queues、Streamを作成します。本番資源とは分離します。現時点では名前・リージョン・保持期間を仮の本番値で埋めません。
4. R2の`r2.dev`公開とPublic custom domainを有効にしません。Streamは常時署名必須です。Bucket Lockは削除できない期間を作るため、保持期間の合意前には設定しません。
5. 接続時には対象資源を限定した資格情報を用意し、Global API Keyをアプリに使いません。値はSecretストアへ設定します。

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
