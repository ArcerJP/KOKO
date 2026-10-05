# 継続的インテグレーション規約

## 目的

Pull Requestの作成・更新時に再現可能な自動検証を行い、既存動作の破壊、構文・書式の不整合、型エラー、リリース不能なbuildをmerge前に検出します。

## 正本

- 実際にGitHub上で実行する内容：`.github/workflows/`。
- CIの適用範囲、未導入項目、追加条件：この文書。
- ローカルで実行する個別command：採用した言語・framework・package managerの設定ファイル。

文書に検査が記載されていてもworkflowに実装されていなければ、自動化済みとは扱いません。workflowが存在しても空のtestやskipだけで終了する場合は、検証済みとは扱いません。

## 実行契機と権限

- PR検査は`pull_request`でPull Requestの作成、commit追加による更新、再open時に実行します。
- merge queueを使用する場合に備え、`merge_group`でも実行します。
- workflowの権限は検査に必要な最小限とし、現在は`contents: read`だけを許可します。
- 外部からのPull Requestで秘密情報を渡さずに実行できる検査を基本とします。
- 外部書込みを行うAPI配備は別workflowです。[開発用API配備](#開発用api配備)の適用条件に従い、PRやmerge queueからは配備しません。

## 現在の導入状態

| 検査                        | 状態       | 現在の実装または未導入理由                                                                                                                      |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 依存関係の再現可能なinstall | 導入済み   | npm workspacesを`npm ci`とlockfileで再現。                                                                                                      |
| format／対応形式の構文解析  | 導入済み   | `.github/workflows/format-check.yml`の`Prettier` jobが`npm run format:check`を実行。                                                            |
| Markdown Linter／静的解析   | 導入済み   | `.github/workflows/markdown-lint.yml`の`Markdown Lint` jobが`npm run lint:md`を実行。                                                           |
| OpenAPIと生成物一致         | CI定義済み | `Contract Schema`：Redocly lint、生成型とエラー表の一致。                                                                                       |
| ユニットテスト              | CI定義済み | `Contract Tests`：Node test runnerで状態・判定・キー・エラー・権限・トークン等を検証。                                                          |
| SQL統合テスト               | CI定義済み | 同jobでPGliteへmigrationを実適用し、14テーブル・制約・grants/RLS・イベント境界を検証。                                                          |
| JS/TS Linter                | CI定義済み | `TypeScript Lint`：契約側ESLint 10とWeb側ESLint 9／Next.js公式設定。生成型は生成一致とtscで検査。                                               |
| 型チェック                  | CI定義済み | `Type Check`と`API Type Check`：契約build、Web/APIのstrict tsc、Wrangler生成型一致。                                                            |
| 契約package build           | CI定義済み | `Contract Build`：共用ESMと型宣言をdistへ出力。Web/API production buildの代替ではない。                                                         |
| Web単体・HTTP／メディア統合 | CI定義済み | `Web Tests`：Vitest、MSW、合成メディアの実トリムとpacket照合、Worker境界。                                                                      |
| Web production build        | CI定義済み | `Web Build`：共有契約build後のNext.js production build。                                                                                        |
| Webブラウザ操作             | CI定義済み | `Web Browser Tests`：production serverを使うPlaywright Chromium。写真・動画・異常入力・モバイル幅。                                             |
| API実行環境テスト           | CI定義済み | `API Tests`：Cloudflare公式Vitest pluginとローカルMiniflareでHTTP境界・R2 binding分離を検証。                                                   |
| API production build        | CI定義済み | `API Build`：実deployと同じWrangler設定を`wrangler deploy --dry-run`でbundle化し、外部へuploadしない。                                          |
| 画像変換コア                | CI定義済み | `Image Type Check`・`Image Tests`：strict tscと実decoderの合成画像・metadata・異常系・CLI検査。                                                 |
| Docker image build          | CI定義済み | `Image Container Build`：画像コア/HTTP/判定adapterの実Dockerfile/runtimeと、その同じ依存・成果物の隔離コンテナー試験。実Cloud Run配備は未実施。 |

契約向け5jobは`.github/workflows/contract-check.yml`に定義しています。workflowの存在とGitHub上の実行成功は別です。PGliteはPostgreSQLエンジンでSQLを実行しますが、Supabase Auth、実OAuth、クラウド通信、認証付きメディア配信を検証していません。これらは第1〜第3要件の別の統合/実機試験です。

Markdownlintは`.gitignore`を尊重して追跡対象相当のMarkdownを検査します。日本語文書と表の可読性をPrettierへ委ねるため、行長の`MD013`を無効化します。また、タスクテンプレートのfront matterにある`title`は文書見出しではなくmetadataとして扱うため、`MD025`ではfront matterを見出しとして数えません。それ以外は既定ruleを使用します。

画像処理の[DB確定](../apps/api/README.md#画像処理のdb確定b2-1の一部実環境未接続)は既存`Contract Tests`の`image-processing.test.mjs`で検査します。全migration・service限定権限・lease/所有者/版・停止/BAN・原本identity・4receipt全検査・例外時の全rollback・冪等再送を対象とし、公開状態やQueue配送完了へ進めないことも確認します。PGlite単一接続の成功を実PostgreSQLの多接続競合や実R2/HTTP/consumerの受入としません。新job、秘密、実DB接続は不要です。

## Web検査とLintの保守

初回参加も既存Contract/API/Web Tests・Web Browser Testsへ含めます。SQL権限/再送/rollback、固定event/本人・Cookie/CSRF、表示名だけの登録、直前の本人変更・取消し・曖昧結果、390/1280pxでの実React操作と実routeの既定OFFを検査します。合成Google/DB応答は実認証・実DB適用・多接続競合の代替ではありません。

Web向け3jobは`.github/workflows/web-check.yml`に定義します。秘密やクラウド課金なしで実行でき、実機のカメラ・実OAuth・R2通信をモック成功で代替しません。詳細は[撮影検証](product/stage-one-capture.md)を参照してください。既存の契約job名は維持し、`Contract Tests`は`test:contract`、`Contract Build`は`build:contract`へ明示的に限定します。

Web Testsにはアップロード制御・同一origin JSON中継・R2直接転送の合成試験を含みます。Web Browser Testsではproduction Route Handlerのupload既定無効を確認します。single/multipartの模擬通信成功と、実R2のCORS・署名・保存・Googleセッション受入は区別します。詳細は[Web README](../apps/web/README.md#アップロード制御とr2直接転送f1-5既定無効)を参照してください。

F2-1のキュー試験では本人分離・永続化失敗・retry上限・曖昧なPUT/complete結果を検査します。Web Browser Testsは既存Chromiumで実IndexedDB・複数tab lock・reload・quota例外rollback・送信UI遷移を合成写真で検証。esbuildはWebの直接dev依存に固定し、テスト内bundleをPlaywright routeで供給します。製品へ認証回避routeやfixtureを配信せず、実秘密/実写真/外部R2を使いません。新送信UIの実動画・実Authの受入は別です。

本人投稿画面も既存Web Testsでquery/応答投影・前後の本人照合・BAN中の読取り・cursor期限切れ・取消しを検査します。Web Browser Testsでは合成Auth/HTTPと実Reactを用い、390/1280pxで読込み/続き/単一更新・終了時破棄・期限切れ回復と、production routeの既定OFFを確認します。実Google/Cookie/Access/DBを通す受入ではありません。[画面の検証境界](../apps/web/README.md#本人の投稿一覧状態画面f2-4f3-4の一部既定無効)を参照してください。

API向け3jobは`.github/workflows/api-check.yml`に定義します。`API Type Check`、`API Tests`、`API Build`は秘密情報やCloudflareログインなしで実行します。テストのR2はローカル保存であり、開発用実バケットとの通信成功を示しません。`API Build`もdry-runであり、Cloudflareへのdeploy成功とは区別します。

本人投稿の状態・一覧は既存`Contract Tests`でread-only SQLの所有権/権限・状態・精度を、`API Tests`で実Web Cryptoの署名cursor・改ざん/期限・最小応答・認証/異常通信を検査します。追加のjobや秘密は不要です。合成Auth/RPCとPGliteの成功は実Supabase適用・Web画面・メディア配信の受入ではありません。[本人投稿APIの実装境界](../apps/api/README.md#本人の投稿状態と一覧b2-6の一部既定無効)を参照してください。

APIが共有契約の生成済み`dist/`を参照するため、rootの`typecheck:api`・`test:api`・`build:api`は、それぞれ`build:contract`の成功後にworkspaceの処理を実行します。別jobや以前のローカルbuildの生成物には依存しません。APIだけを検証する場合もroot commandを使用し、workspaceの下位commandを直接実行する場合は共有契約buildを先に行います。2026-10-03のPR #15で判明した準備漏れへの対応です。再現検査ではlockfileどおり依存を導入し、各commandの前に共有契約の生成物がないことを確認します。親ディレクトリに別の`node_modules`があるコピーだけでは依存解決の独立性を保証できないため、GitHub CIの新規checkoutでも結果を照合します。

[メディア処理予約の配送](../apps/api/README.md#メディア処理予約のqueue配送b1-6の後段既定無効)は既存`Contract Tests`でservice限定RPC・lease/世代・有限retry・処理状態不変を、`API Tests`で模擬Queueの遅延/失敗・曖昧結果・最小message・RPC期限/サイズ・既定OFFを検査します。新job・秘密・実bindingは追加しません。PGlite単一接続と模擬producerは実PostgreSQLの多接続競合・実Queue/DLQ・変換consumerを検証しません。

`API Tests`には`npm run test:deploy-workflow`も追加しています。既存のAPI実行環境テストとjob名は維持し、配備jobをPRの必須checkには追加しません。

## 画像変換コアの検査

第3集約実装では既存jobのまま、Stream準備/署名Webhook・固定eventのQueue配送/consumer・通知outbox/容量監視・認証付きmedia/個別原本取得・お題/通報/管理・安全な状態投影・費用snapshotを検査します。Webにはgrid/全画面・HLS・お題選択・本人操作・管理画面の単体/Chromium試験を追加。内部cacheでも認可を省略しないこと、停止/BAN/版変更・遅延・失敗・有限retryを対象とします。AI/課金APIは合成応答で、実秘密・有料呼出し・公開・実配備は行いません。これらの成功は実環境の負荷/費用/失効SLOや実端末の受入を代替しません。

判定接続には固定DB client/AI/Stream frame取得のmockと、PGlite全migration→HTTP→実decode→模擬AI→DB判定確定/再送の縦通しを含めます。Docker verification stageだけにroot dev依存のPGliteとmigrationをコピーし、production runtimeには追加しません。実サービス受入、校正、競合/負荷の証明とは区別します。

認証HTTPも既存Image Tests/Container Buildへ含めます。合成RSA署名・Google JWKS fixtureを用いてaud/主体/期限・不正鍵・timeoutを検査し、Node loopbackで本文上限・header重複・最小応答と既存runner接続を確認。外部Google認証、実IAM、実DB/実R2、配備は行いません。Dockerの明示`service` targetとCLIは同じbuild成果物を使います。

内部pipelineの試験も既存`Image Tests`と`Image Container Build`で実行します。`test/pipeline.test.mjs`は実decoderと模擬R2を通す再送、全確認点の中断、部分失敗・改変を検証。追加の`test/db.test.mjs`・`test/runner.test.mjs`は固定RPC・秘密非露出・応答/期限制限・claim→7地点check→finish・記録済み再配送を確認し、実decoder＋署名付き模擬R2＋模擬DB通信の通し試験も行います。Dockerの明示test一覧にも追加し、新job/秘密情報/実クラウド書込みはありません。実SQLは別PGlite試験で、実DB/PostgREST/IAM・実機受入を検証済みとはしません。

既存Image TestsとImage Container Buildには、R2ストレージadapterの合成fetch試験を含めます。固定キー/署名・原本GET・派生物の条件付きPUT/既存内容照合・期限/サイズ/redirect/異常系を検証し、実HEIC変換→4閲覧派生物の模擬保存も実行します。Dockerは共有契約も同一ソースからbuildしてruntimeへ含めます。実バケット・秘密・課金・DB/consumerを使う試験ではありません。

画像向け3jobは`.github/workflows/image-check.yml`に定義します。画像変換の仕様・実機未受入・依存/配布境界は[画像コアREADME](../apps/image/README.md)が正本です。Node test runnerによる実HEVC符号化の合成fixtureを含みますが、実端末HEIC・HDR・SLO・クラウド受入ではありません。JS/TS lintは既存`TypeScript Lint`で画像workspaceも対象にします。rootのtypecheck/test/buildにも接続し、Docker試験だけは`npm run test:image:docker`で別実行します。新jobの定義と、mainの必須checkへの登録は別工程で、登録はmerge後に本人が行います。

## 開発用API配備

2026-09-29にローカル実装・検証を完了し、その後の本人による準備と切替を経て、2026-10-02までにActionsの初回手動配備と通常main更新による自動配備を確認しました。採用理由は[ADR-0003](decisions/ADR-0003-worker-scoped-deployment.md)、配備後確認・残る検証と日付付き証拠は[クラウド準備の進捗2026-10-02](product/cloud-setup.md#項目別の進捗2026-10-02更新)を参照してください。PRのCI成功だけを実配備成功とは扱いません。

実装の正本は[api-deploy.yml](../.github/workflows/api-deploy.yml)と[実行ガード](../.github/scripts/api-deploy.mjs)、外部の適用済み状態は[クラウド準備の最新記録](product/cloud-setup.md#2026-10-03の配備障害と再発防止)です。再開時の現物確認、診断、変更、配備受入の順序には[api-deployment Skill](../.agents/skills/api-deployment/SKILL.md)を使用します。

| 境界       | 実装                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 開始       | `ArcerJP/KOKO`の`refs/heads/main`、pushまたは手動実行のみ。任意入力なし                                                                                    |
| 自動配備   | Repository variable `KOKO_API_AUTO_DEPLOY_ENABLED`が小文字の`true`に完全一致するときだけ。未設定・空・false・その他はOFF。手動経路はこのフラグに依存しない |
| 検証       | Secretなしで同じイベントSHAをcheckoutし、Node 24・lockfileによる導入、配備回帰試験、API型・テスト・dry-run build                                           |
| 配備       | verify成功と許可出力が必須。専用Environment `koko-api-dev`で同じSHAを再checkoutし、導入・共有契約build後の最終stepだけSecret参照                           |
| 直前ガード | イベント・repository・ref・verify結果・秘密の存在・checkout SHAを再検査。固定GitHub APIのGETで最新mainとSHA一致を確認できなければ書込み停止                |
| 資格情報   | Cloudflareトークンとaccount IDは最終stepだけ。そのstepのGitHub tokenはmain照会にだけ使い、npm/Wranglerへは渡さない                                         |
| 実行       | 固定済みWranglerの`npm run deploy --workspace @koko/api`。worker/config/commandの任意上書きなし                                                            |
| 競合・停止 | 手動/自動で共通concurrency、実行中は自動cancelしない。各jobは15分上限。自動再試行なし                                                                      |
| 依存・権限 | 公式checkout/setup-nodeを完全SHA固定、persist-credentials false、contents readだけ、cacheや他workflowのartifactは不使用                                    |

concurrencyはCloudflare Buildsを止めません。またmain確認とCloudflare書込みは原子的ではなく、確認後の新しいmergeまで防止しません。初回切替中はmain更新を止める時間帯を本人と合意します。通常運用では次のrunが最新mainを再検証します。待機runが新しいrunで置換される場合があるため、全commitが必ず順に配備される保証はありません。

トークンの実際の権限・期限とEnvironmentの保存済み保護設定は、workflowだけでは確認できません。外部設定の事前確認を省略せず、Repository/Organization Secretへの代替登録や、保護未設定Environmentの暗黙作成を使いません。

回帰試験は[.github/tests/](../.github/tests/api-deploy-workflow.test.mjs)で管理し、ローカルの`npm test`と既存`API Tests`から実行します。実ガードに模擬資格情報と模擬ネットワーク・実行処理を渡し、重要条件を壊したworkflow fixtureも失敗させます。実Cloudflareへの書込みはありません。Action更新時は上流のSHAを確認し、workflowと試験の固定値を同時更新します。

ジョブのskip、dry-run、ローカル試験成功は実配備成功ではありません。通信失敗・タイムアウト後は、Active Deploymentを照合してから再試行を判断します。

### 配備metadataの読取り専用診断

`API Deploy Diagnostics`を[api-diagnose.yml](../.github/workflows/api-diagnose.yml)に定義します。実処理は[api-diagnose.mjs](../.github/scripts/api-diagnose.mjs)、回帰試験は[api-diagnose.test.mjs](../.github/tests/api-diagnose.test.mjs)です。2026-10-03にPR #17をmainへ反映し、実診断で2GETの403を特定しました。本人承認の読取り権限追加後は7GET成功です。その後の単回配備#9はmetadata取得を通過しましたが、R2設定の差分で`--strict`がupload前に停止しました。限定互換修正のmerge後、10月4日の単回配備#13は成功しています。診断は配備workflowへ自動接続していません。追加観測・実配備・残る受入の正本は[クラウド準備](product/cloud-setup.md#r2修正後の単回配備2026-10-04)です。

対象はWranglerがDashboard更新後に追加取得するmetadataです。固定Worker `koko-api-dev`のservice情報からenvironment名を検証して取り出し、bindings、routes、custom domains、subdomain、service environment、schedulesを各1回GETします。最初のservice取得に失敗した場合やenvironment名が不正な場合はそこで停止し、`production`等を推測して続けません。追加6件の一部失敗では残りも確認し、失敗した取得先を分けて記録します。[Wranglerの取得処理](https://raw.githubusercontent.com/cloudflare/workers-sdk/wrangler@4.147.0/packages/deploy-helpers/src/deploy/helpers/download-worker-config.ts)

- 実行：`ArcerJP/KOKO`のmainから手動の`workflow_dispatch`のみ。任意入力、push・PR起動なし。実行contextとcheckout SHAもスクリプトで検査。
- 資格情報：配備と同じEnvironment `koko-api-dev`の既存Secretを最終stepだけで使用。追加トークン・権限・秘密値の再入力は不要。checkout確認用Git子プロセスには資格情報を渡さない。
- 通信：`https://api.cloudflare.com/client/v4`の固定取得先へGETのみ。リダイレクト禁止、各リクエスト15秒・本文256 KiB上限、job 5分上限、再試行なし。Node標準機能のみで、npm install・Wrangler・配備処理・artifact保存なし。
- 出力：取得先の固定名、HTTPステータス、固定の結果分類、数値エラーコードのみ。配備元は`dash`／`api`／`wrangler`／`other`に限定。レスポンス本文・binding値・headers・例外本文・秘密値は表示しない。Nodeのdebug・追加起動オプションも無効化。
- 判定：すべて成功はexit 0と`ALL_METADATA_READS_OK`。取得失敗・安全条件違反はexit 1。HTTP 401/403、APIエラー、通信例外、本文解析失敗を区別するが、通信例外の詳細は秘密非出力を優先して`REQUEST_FAILED`へ集約する。全GET成功でも、設定差分の安全性・upload・Supabase接続・受入成功を意味しない。
- 検証：模擬通信の試験とworkflow改悪fixtureを既存`test:deploy-workflow`へ含め、ローカル`npm test`と`API Tests`で検査する。テストは実トークンを使わず、Cloudflareへ接続しない。

2026-10-03の追加変更として、bindings取得成功後に`r2_binding_shape`を1行出す実装を[PR #18](https://github.com/ArcerJP/KOKO/pull/18)で追加しました。同日の[診断 #4](https://github.com/ArcerJP/KOKO/actions/runs/37130145092)で追加観測を確認し、R2接続先2件の一致・両方ABSENTを実証しました。実行SHAと外部状態の正本は[クラウド準備](product/cloud-setup.md#r2設定差分と読取り診断の追加2026-10-03)です。診断成功と修正後の実配備成功は区別します。

- 新たな通信・権限・任意入力は追加せず、同じbindings応答をメモリ内だけで分類する。
- 出力は固定名`ORIGINALS_BUCKET`/`DERIVED_BUCKET`、一致件数、期待Bucket名との一致boolean、R2件数、`expectedPairsMatch`だけ。応答側の未知のbinding名・bucket名は出さない。
- jurisdictionは`ABSENT`（プロパティなし）、`NULL`、`EMPTY`、`EU`、`FEDRAMP`、`OTHER`、`UNAVAILABLE`の固定分類のみ。任意文字列・値は出さない。重複/欠落は`UNAVAILABLE`で、期待する2件と接続先が揃わなければ`expectedPairsMatch=false`。
- 正常に分類できれば`result=OBSERVED`、bindingsの構造が不正なら`INVALID_BINDINGS`。HTTP/API失敗時は分類しない。
- これは追加の観測出力で、既存の終了コードと`ALL_METADATA_READS_OK`は通信/API取得の成否のまま。`OBSERVED`やexit 0を設定一致・配備可能の判定に使わない。`INVALID_BINDINGS`、想定外の分類、接続先不一致なら、修正の実適用へ進まず調べ直す。
- 既存試験を含む配備/診断回帰161件が成功。未知値・秘密のcanary・workflow commandの非出力、同じ7GET、missing/duplicate、異常応答を確認した。

2026-10-03の[継続承認方針](../AGENTS.md#作業進行と承認境界)に従い、条件を満たす通常PRの公開と既存読取り診断は毎回の許可待ちを省きます。実配備や保護設定の変更は含めず、次の順序と[api-deployment](../.agents/skills/api-deployment/SKILL.md)の条件を守ります。

1. **mainへのmerge前・診断前に自動配備OFFと進行中/待機中の配備なしを読み取る。** 読取り確認は再承認不要です。診断workflow自体に配備処理はありませんが、main更新で既存`API Deploy`が起動し得ます。停止のためにvariable変更やrun取消しが必要な場合は、その対象操作の個別確認を受けます。OFFでも既存の手動配備は防げないため、診断中は手動配備・Dashboard変更も行いません。
2. コードレビュー・CI・本人merge後、main SHA・コード・対象・アカウント・既存権限の一致を照合し、起動を通知して既存診断を1回手動実行する。[GitHubの仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)上、workflowは既定ブランチに存在する必要があります。新たな認証や権限、秘密表示を必要とする場合は継続承認の対象外として止めます。既存Environmentの保護を緩和しません。
3. ログから取得先・HTTP・エラー番号を照合し、必要最小限の修正を別途判断する。権限追加、`--strict`解除、Secret再登録、配備再試行を自動で行いません。終了後の自動配備再開も別途承認・確認します。

診断用concurrencyは配備と分離し、待機中の配備runを診断で置き換えません。そのためCloudflare設定との同時変更をロックする仕組みではなく、上記の停止・調整が必要です。Environment利用によりGitHub上でdeployment記録が作成され得ますが、Cloudflareへコードを配備することとは区別します。トークン自体は書込み権限を持つため、GET限定のコードレビューと既存Environment保護は引き続き必要です。

### Wrangler R2未指定値の限定互換修正

2026-10-03、実環境の診断と固定版の再現が一致したため、[patch-wrangler-r2.mjs](../.github/scripts/patch-wrangler-r2.mjs)を追加しました。配布版4.147.0のR2 metadata変換1箇所だけを変更し、APIで未指定のjurisdictionをundefinedプロパティとして生成しないようにします。null・空文字・指定済み地域は残し、実設定の変更/削除や`--strict`を緩和しません。

- 適用経路：[API package](../apps/api/package.json)の`prebuild`と`predeploy`。ローカル/PRのdry-run buildと、既存ガード通過後の実deployで同じ処理を通します。`npm ci`直後は原版で、build/deploy直前に適用します。診断workflowには適用しません。
- 対象：APIが直接解決するWrangler 4.147.0だけ。Vitest plugin内の別版や、リポジトリ外のインストールには適用しません。package名・版、実path、CLI全体の適用前後SHA-256、置換箇所が1つであることを検証します。固定値の正本はscriptです。
- 冪等性：検証済み修正後hashなら再書込みなし。それ以外の版/hash、書込後不一致、未知引数は固定理由だけを出して非0終了。例外本文・秘密・ファイル内容は出力せず、通信やWrangler起動はしません。
- 検査：[互換修正試験](../.github/tests/wrangler-r2-compat.test.mjs)29件を既存`test:deploy-workflow`へ含めます。hashを確認した実バンドルからmapper・設定生成・diffの純粋関数だけを抽出し、修正前の空差分を再現、修正後の解消と実差分の拒否を検証します。テスト自体はCLI・実通信・node_modules書込みを行いません。
- 運用：npm lifecycleを無効化したり、direct Wranglerで前処理を迂回したりしません。`--check`は書込みせず修正済み状態を検証します。不一致をhash更新だけで回避せず、実際の依存と上流変更を調査します。部分書込み等で壊れた生成物は、元ソースを保持して同じlockfileの`npm ci`から再現します。
- 解除：公式修正のある版を検証できた段階で通常PRから依存更新とこの前処理/専用試験の撤去を行います。今回の修正自体を取り消す場合も、呼出し・script・試験を通常PRで戻し、再installで原版へ戻します。曖昧な逆パッチやforce pushは使いません。

版固定の局所修正により不要な依存更新・権限追加を避けられますが、独自保守と更新時検証の負担は残ります。修正はmainへmergeされ単回配備に成功していますが、実装・実配備・受入・自動配備再開はそれぞれ別工程です。現在の受入範囲と自動配備OFFは[クラウド準備](product/cloud-setup.md#r2修正後の単回配備2026-10-04)を参照してください。

## 開発用Lintの互換性と移行課題

WebだけESLint 9.39.5を使用する構成はユーザー承認済みです。Next.js公式設定が使うimport／React／アクセシビリティのプラグインはESLint 10をpeer範囲に含めないため、契約側のESLint 10を変更せず分離します。`--force`や`--legacy-peer-deps`で互換性違反を無視しません。lockfileの再現と`npm ls --all`を検査します。

ESLint 9は2026-08-06にEOLとなっています。[公式サポート表](https://eslint.org/version-support/)で判明したこの追加リスクを含め、一時利用と移行方針は2026-09-23にiijimaが承認しました。開発・CI専用で本番の実行依存ではありませんが、既知の脆弱性0件を将来の安全保証にはしません。公式プラグインの10対応時に移行し、lint・型・全試験・buildを再検証します。

`package.json`のscoped overridesでNext.js配下を9系へ固定し、9／10の両方に対応するTypeScript ESLintとeslint-utilsの共有helperは既存のroot版を参照します。npmのhoistによるpeer競合を避けるための設定です。バージョン更新時は、overrideも含めて`npm ci --strict-peer-deps`と`npm ls --all`で再検証してください。

## 依存関係のセキュリティ更新

### 2026-10-03の追加監査：開発用依存のHigh 7件

`npm audit --json`はHigh 7パッケージ、`npm audit --omit=dev --json`は0件でした。7件は`braces@3.0.3`の[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)から間接依存へ波及した数であり、7個の独立した脆弱性ではありません。`npm ls`とlockfileで、次の開発用依存経路を確認しています。

- `markdownlint-cli2` → `globby`／`micromatch` → `braces`（`globby`は`fast-glob`も使用）。
- `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`。

[上流の報告](https://github.com/micromatch/braces/issues/70)では、信頼できない深いbraceパターンによりNode.jsのスタックを枯渇させるDoSが対象です。確認時点のアドバイザリに修正版の記載はありません。現在のアプリソースにこれらのglob処理の直接利用はなく、Markdownの対象patternは固定の`**/*.md`、Next.js Lint設定に任意の`settings.next.rootDir`はありません。このため公開APIへの直接の攻撃経路は今回確認していません。ただし本番依存の監査0件だけで安全を保証できず、設定・pattern・入力経路が変われば開発／CIの停止リスクがあります。

今回の承認は影響調査までで、依存・lockfileの更新、検査無効化、脆弱性の恒久受容は行っていません。npmの自動修正候補にはNext.js ESLint設定14系やmarkdownlint-cli2 0.0.4への大幅なdowngradeが含まれるため、`audit fix --force`は使用しません。対応判断は、上流修正版の確認と影響調査の継続（互換性への影響は小さいが指摘は残る）、または検証済みの依存置換／緩和（早期対処の可能性はあるが保守・互換性確認が増える）を比較して別途行います。

### 2026-10-03のWrangler限定更新

[API Deploy #6](https://github.com/ArcerJP/KOKO/actions/runs/37101002506)では、認証APIを含むmain `4c4a5ec`の検証jobが成功した一方、Wrangler `4.145.0`による配備はCloudflareのbindings・routes・services metadata取得で失敗しました。承認済みの再実行でも同じ失敗を確認したため、配備ツールの切り分けとして直接依存を`4.147.0`へ固定更新しました。

Wranglerが指定するMiniflare `5.20261001.0-alpha`とworkerd `1.20261001.1`、および生成型を同時に更新しました。Cloudflare Vitest plugin `1.3.4`は変更せず、その内部のWrangler `4.145.0`／Miniflare `5.20260930.0-alpha`／workerd `1.20260930.2`は上流の指定どおり残します。lockfile内の旧版はこのテスト用経路であり、配備は`@koko/api`の直接依存`4.147.0`を使用します。`compatibility_date`、Worker設定、アプリの認証処理、配備ガードは変更していません。

[4.146.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.146.0)と[4.147.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.147.0)の公式リリースには、今回のmetadata取得失敗に対する直接の修正は明記されていません。ローカル検査・dry-run成功を原因特定や実配備成功と扱わず、承認後の実配備で効果を確認します。同じ失敗が続く場合は認可・API応答を追加調査し、権限拡大や`--strict`の解除を自動で行いません。

その後、PR #16のmergeによる[API Deploy #7](https://github.com/ArcerJP/KOKO/actions/runs/37105605539)でも同じmetadata取得失敗を確認しました。版更新だけでは解消していません。Dashboard更新後の追加読取りと、routes・custom_domainsの403が原因でした。限定した読取り権限の追加で診断7GETが成功した経緯と根拠は[原因記録](product/cloud-setup.md#原因と検証済みの範囲)を参照してください。今後は共通エラーだけを根拠に版更新せず、失敗APIを診断します。

ローカルでは再現install、依存整合性、format、Markdown、契約生成一致、型、179件の契約・Web・API・配備ガード試験、7件のChromium E2E、Web/API buildが成功しました。Lintは作業ツリーに以前から残るGit対象外の一時ファイルを拾って失敗したため、Git管理ファイルと今回の差分だけを展開し、同じlockfileで依存を導入した一時コピー上で、除外オプションを足さない`npm run lint`の成功を確認しました。既存の一時ファイルやLint設定は変更していません。監査は引き続き開発用High 7件・本番実行依存0件で、この更新による追加指摘はありません。GitHub CIと実配備は別途確認します。

### 2026-10-02の更新

2026-10-02の更新前監査では、Next.jsとCloudflare開発・配備依存を合わせて5パッケージに指摘がありました（critical 1、high 1、moderate 3。同じ間接依存からの波及を含み、5個の固有の脆弱性という意味ではありません）。修正版は各workspaceの`package.json`とrootの`package-lock.json`に固定します。

| 対象                     | 更新              | 目的                                                                  |
| ------------------------ | ----------------- | --------------------------------------------------------------------- |
| Next.js／公式ESLint設定  | 16.3.5 → 16.3.8   | `next/og`の修正と、その後のセキュリティ修正を含む同一minorのpatch更新 |
| Wrangler                 | 4.136.3 → 4.145.0 | 修正済みMiniflare／Undiciへ更新                                       |
| Cloudflare Vitest plugin | 1.2.3 → 1.3.4     | 上流が指定する同じWrangler／Miniflareの組合せを使用                   |

Next.jsの[上流アドバイザリ](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)は、Node.js版`ImageResponse`へ攻撃者が制御するSVG入力を渡す経路を対象とします。現在のアプリソースに`next/og`／`ImageResponse`の利用は確認されませんが、脆弱版を維持する理由にはしません。[16.3.8のリリース](https://github.com/vercel/next.js/releases/tag/v16.3.8)に含まれる追加修正も取り込みます。React、アプリ仕様、ESLintの9／10分離は変更しません。

UndiciはCloudflareのローカル実行・試験・配備ツールからの間接依存です。[WebSocketのDoS](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5)と[BalancedPoolのTLS検証回避](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3)を含む監査指摘の修正版7.29.1を使用します。Worker本体に同じNode.js依存を配布しているとは扱いませんが、配備ツールは資格情報を扱うため更新対象です。

更新時は`npm ci --include=dev --strict-peer-deps`、`npm ls --all`、`npm audit --json`と、下記の全CI相当検査を実行します。監査0件は検査時点の既知の指摘に限り、将来の安全性や攻撃経路の不存在を保証しません。ESLint 9のEOLは上記の独立した残課題です。新しい権限・bindingを追加せず、Wranglerの生成型は既存の`compatibility_date`を維持して更新します。dry-run成功と実配備成功は区別し、merge後に自動配備・Access・healthを受け入れてから後続PRをmergeします。

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
npm.cmd run test:image:docker
```

## 必須status check

workflowを追加しただけではmergeを技術的にブロックできません。新しいjobは、導入PRで実行成功を確認してから、下記の順序でmainのRulesetまたはBranch protection ruleへ登録します。

`Prettier`、`Markdown Lint`、`Contract Schema`、`TypeScript Lint`、`Type Check`、`Contract Tests`、`Contract Build`、`Web Tests`、`Web Build`、`Web Browser Tests`に加え、`API Type Check`、`API Tests`、`API Build`もmainで必須化されています。APIの3checkは2026-09-23に導入PRで成功し、管理者の再認証・保存とPR上のRequired表示を確認しました。既存checkと承認レビュー要件を維持します。

### 新しい必須checkを導入する順序

2026-10-05、本人の設定完了報告後にmainの実効rulesを再読取りし、既存13checkに加えて`Image Type Check`・`Image Tests`・`Image Container Build`の計16checkが必須登録されていることを確認しました。PR #43直後の未登録という記録を更新します。AIは保護設定を変更していません。各PRの最新headで実際に成功したか、送信元・Required表示・独立レビューの条件を満たすかは引き続き個別確認します。

1. workflow、検査command、検査対象を同じPRへ追加し、そのPRの最新commitで成功を確認します。
2. 人間のレビューを経て導入PRをmainへmergeします。
3. 既存PRへ最新mainを取り込み、新しいworkflowが存在し実行できることを確認します。
4. 管理者が新しいjob名を必須status checkへ追加し、送信元をGitHub Actionsへ限定します。PR上で結果とRequired表示を確認します。

新しいcheckを導入PRのmerge前に必須化すると、そのworkflowを含まない既存PRが`Expected — Waiting for status to be reported`で止まります。これは実行中や失敗を示すものではなく、結果を待つ状態です。定義のないcheckは、既存workflowを再実行するだけでは届きません。

### Expectedの解消と依存PR

対象PRの最新commitにworkflowと必要なソースがあるか、実行契機・branch/path filter・job名・結果の送信元が必須設定と合うかを確認します。workflowを含むmainを取り込んで、PR更新による実際の検査を実行します。mainに未導入なら、先に導入PRをレビュー・mergeします。空の成功job、skip、手動の成功statusで代替しません。

導入PRのmerge前に後続PRも検査する必要がある場合は、導入PRのブランチを後続ブランチへ通常mergeし、後続PRの比較元も導入ブランチへ一時的に変更します。これにより、後続PRの差分をその目的に絞ってレビューできます。ただし作業ブランチを比較元にしたPRには、main向けRulesetがそのまま適用されるとは限りません。後続PRはDraftにして誤mergeを防ぎ、**作業ブランチへmergeしません。**

導入PRをmainへmergeした後、後続ブランチで`git pull origin main`を行い、後続PRの比較元をmainへ戻してReady for reviewにします。Squash mergeの場合も最新mainを通常mergeして履歴と差分を確認し、最新commitの全必須checkと承認レビューを経てmergeします。先行ブランチの削除は、後続PRの比較元をmainへ戻した後に行います。

`Review required`はCIとは別です。PR作成者は自身のPRを承認できず、「最後にpushした人以外の承認」が必要な設定では、そのpushを行ったアカウントのApproveだけでも条件を満たしません。両方の条件を満たす、Write権限を持つ別の共同開発者によるレビューが必要です。再発防止の正本は[git-workflowのアカウント一致手順](../.agents/skills/git-workflow/SKILL.md#pushとpr作成のアカウント一致)です。CI成功とレビュー要件の充足を混同しません。

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
