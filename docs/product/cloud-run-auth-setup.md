# Cloud Run認証の準備（本人操作）

更新日：2026-10-09。採用理由は[ADR-0007](../decisions/ADR-0007-private-image-service.md)、現物確認は[cloud-setup](cloud-setup.md#2026-10-09の請求先リンク確認とapi準備)を参照します。**中継コードとQueue接続はローカル実装済み、実接続は未受入です。**

## 今の目的と影響

Googleの長期秘密鍵を作らず、既存Vercelの署名IDから短命のGoogle ID tokenを取得する準備です。**第1〜6節は完了確認済み。やり直し不要です。今する作業は第7節のGoogle CLIログインだけです。** Codexが公式CLIと固定ソースのコンテナーをローカルで準備・検証しました。CLIの本人認証は未実施です。プールON、公開化、Secret登録、コンテナー送信、実配備は含みません。

APIの初期化時に有効化されたサービスはcloud-setupを参照してください。有料アップグレード・前払い・想定外の追加契約を求められたら、その先へ進まず画面の名称だけ知らせてください。再認証・パスワード入力は本人が行い、秘密は送らないでください。

非秘密の入力準備と画面上の照合は、依頼を受けたCodexが担当できます。最後の保存と、その後のIAM・秘密・有効化・配備は本人ゲートを維持します。未保存フォームの入力完了をプール作成済みと扱いません。

## 1. Google Cloudでプールを作成（完了・参照用）

1. [KOKOのWorkload Identity連携](https://console.cloud.google.com/iam-admin/workload-identity-pools?project=koko-510318)を開き、プロジェクトが`KOKO / koko-510318`であることを確認します。
2. 「プールを作成」または「開始」から作成画面へ進みます。既に作成画面が開いていれば重ねて開始しません。
3. 以下を入力します。プールIDは後から変更できません。

   | 項目             | 指定値                                                     |
   | ---------------- | ---------------------------------------------------------- |
   | 名前 / プール ID | `koko-cloud-run` / `koko-cloud-run`                        |
   | 説明             | `KOKO private image service caller from Vercel production` |
   | 有効なプール     | **OFF**（無効のまま準備）                                  |

4. 「続行」でproviderへ進み、以下を設定します。

   | 項目                   | 指定値                                     |
   | ---------------------- | ------------------------------------------ |
   | providerの種類         | `OpenID Connect（OIDC）`                   |
   | provider名 / ID        | `koko-vercel` / `koko-vercel`              |
   | issuer URL             | `https://oidc.vercel.com/arcer2`           |
   | JWK JSONのアップロード | **空欄**。公開鍵はissuerから取得           |
   | audience               | 「許可されたaudience」を選択               |
   | audience 1             | `https://vercel.com/arcer2`（これ1件だけ） |

5. 「続行」で属性へ進み、mappingを`google.subject = assertion.sub`にします。
6. 「属性条件 / Attribute condition」には次の全体を貼り付けます。条件を空欄にしたり、Previewも許可したりしません。

   ```text
   assertion.project_id == 'prj_lFsBBscXyqDzTLjH9FOOsv9tnhii' && assertion.sub == 'owner:arcer2:project:koko-web:environment:production' && assertion.environment == 'production'
   ```

7. issuer、audience、mapping、条件、**プール無効**を確認して「保存」。画面が異なる・条件エラーがある場合は、条件を緩めず止めます。
8. 詳細画面でプール/provider IDと無効状態を確認し、「WIFプール作成済み・無効」と知らせてください。秘密鍵・JWT・認証コードは不要です。

[Vercel公式のGoogle連携](https://vercel.com/docs/oidc/gcp)をKOKO用に限定した手順です。例にあるStorage Object Adminや広いproject権限は付与しません。固有project IDのclaimは[OIDC公式仕様](https://vercel.com/docs/oidc/reference)を根拠にし、実tokenでの照合は受入時に別途実施します。

## 2. 専用アカウント2件（作成済み・参照用）

2026-10-07、本人が「2アカウント作成済み・鍵とロール追加なし」と報告。callerのIDは画面で `id-koko-cloud-run-caller` へ自動変換されたため採用した、との本人説明です。Codexも一覧と詳細で下記を照合しました。表示名をIDと取り違えず、今後の設定には**実際のメールと数値ID**を使います。作り直し・改名・削除は不要です。

| 項目                 | 呼出し役                                                       | 画像処理役                                               |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| 表示名               | `koko-cloud-run-caller`                                        | `koko-image-runtime`                                     |
| サービスアカウントID | `id-koko-cloud-run-caller`                                     | `koko-image-runtime`                                     |
| メール               | `id-koko-cloud-run-caller@koko-510318.iam.gserviceaccount.com` | `koko-image-runtime@koko-510318.iam.gserviceaccount.com` |
| 一意の数値ID         | `112882822082848355348`                                        | `113117666142374318919`                                  |
| 説明                 | `KOKO Vercel WIF caller only; no keys`                         | `KOKO private image service runtime; no keys`            |
| 一覧の表示           | 有効・キーがありません                                         | 有効・キーがありません                                   |

確認先：[KOKOのサービスアカウント一覧](https://console.cloud.google.com/iam-admin/serviceaccounts?project=koko-510318)。続く10/7の読取りで、両アカウントのアクセス一覧はプロジェクトから継承する本人のOwnerのみでした。callerとプロジェクトIAMは「Google提供のロール付与を含める」でも確認し、caller/runtimeへのプロジェクトロールやWIF principalの追加を認めませんでした。これは表示したIAM一覧の確認で、組織・別リソース・グループ経由を含む全実効権限の監査ではありません。鍵の発行・IAM変更・課金・配備は行っていません。

`KOKO_IMAGE_CALLER_EMAIL` は呼出し役のメール、`KOKO_IMAGE_CALLER_SUBJECT` は呼出し役の一意の数値IDを使います。runtimeのメール/ID、表示名、プロジェクト番号で代用しません。まだ実環境へ値を登録していません。WIFプールはOFFを維持し、Owner/Editor等の広いロールや長期JSON鍵を追加しません。

[Google公式のサービスアカウント作成手順](https://docs.cloud.google.com/iam/docs/service-accounts-create)に基づき、作成と省略可能な権限設定を分離しています（2026-10-07確認）。

## 3. callerへの限定WIF権限1件（完了・参照用）

2026-10-07、本人の保存完了報告後、callerの一覧で下記の完全principalと「Workload Identity ユーザー」1件、継承されていない直接付与を確認しました。既存Ownerは維持され、プールはOFF（`aria-checked=false`）です。**再追加・再保存は不要。** 実token交換・Cloud Run呼出しはまだ検証していません。第2節の「Ownerのみ」は付与前の読取り履歴です。

**目的**：後でプールを有効にしたとき、KOKOのVercel productionだけが「呼出し役」を使えるよう準備します。今回はcallerへの委任権限1件だけで、プールはOFFのままです。既存権限を消したり、プロジェクト全体へロールを付けたりしません。

### 保存前に知っておくこと

- 対象は `KOKO / koko-510318` 内の**呼出し役1件**。`koko-image-runtime` には付けません。
- `roles/iam.workloadIdentityUser` はGoogleのWIF標準手順のロールです。**ID tokenだけでなくaccess token発行も許可**するため、無害な名前登録ではなく権限の追加です。callerへ将来付ける資源権限も、特定Cloud Runの呼出しに限定します。
- プールOFFを維持し、この手順ではtoken交換・鍵作成・API有効化・Cloud Run作成・実配備をしません。課金/契約操作は含みません。準備予算8,000円は支出上限の自動設定ではありません。
- 同一principal・同一ロールが既にあれば重複追加せず、画面の状態だけ知らせてください。違う対象・広い権限が出たら保存せず止めます。

### 本人が操作する手順

以下は実施済み手順の参照です。Codexがprincipalとロールを入力し、初期選択の「サービス アカウント管理者」を指定の「Workload Identity ユーザー」へ変更して、本人が最終保存しました。現在は保存済み一覧で確認できています。

1. [呼出し役のアクセス一覧](https://console.cloud.google.com/iam-admin/serviceaccounts/details/112882822082848355348/access?project=koko-510318)を開きます。見出しは `koko-cloud-run-caller`、対象メールは第2節の `id-` 付きのものです。**プロジェクトの「IAM」一覧ではありません。**
2. 「アクセス権を持つプリンシパル」タブで「アクセスを許可」を押します。
3. 「新しいプリンシパル / New principals」へ次の1行をそのまま貼ります。コロンを変更・URLエンコードせず、空白や改行を加えません。

   ```text
   principal://iam.googleapis.com/projects/468956212777/locations/global/workloadIdentityPools/koko-cloud-run/subject/owner:arcer2:project:koko-web:environment:production
   ```

4. 「ロールを選択」で **Workload Identity ユーザー / Workload Identity User** を検索し、ロールIDが `roles/iam.workloadIdentityUser` のものを1件だけ選びます。「サービス アカウント ユーザー」「サービス アカウント トークン作成者」「オーナー」「編集者」は選びません。追加のIAM条件は設定せず、保存済みproviderのproject/production条件を変更しません。
5. 対象がcaller、principal末尾が `environment:production`、ロールが上記1件だけであることを本人が確認して「保存」を押します。pool全体の `principalSet`、`allUsers`、`allAuthenticatedUsers` は使用しません。
6. 一覧に追加したprincipalとロールが表示されることを確認します。[プール詳細](https://console.cloud.google.com/iam-admin/workload-identity-pools/pool/koko-cloud-run?project=koko-510318)のスイッチは**OFFのまま**にし、切り替えません。10/7の直前読取りでは `aria-checked=false` でした。横の「有効」という文字だけでONと判断しません。
7. 次の2行だけ返信してください。秘密やtokenは不要です。

   ```text
   callerのWIF権限追加済み
   プールOFFのまま
   ```

再構築時に入力拒否・異なる画面・想定外の確認が出たら、権限や条件を広げて解決せず止めます。今回の保存済みbindingの確認は、この1件の権限と設定の確認であって、token交換成功や後続操作への包括承認ではありません。

取消しが必要なら、このcaller上の**今回追加したprincipalとロールの組だけ**を外す案を確認します。既存Owner、サービスアカウント、プール自体を削除しません。既発行tokenまで即時失効する保証とは別なので、運用開始後の取消しは停止・有効期限の確認も必要です。

根拠（2026-10-07確認）：[GoogleのWIF委任手順](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)、[サービスアカウントへのアクセス管理](https://docs.cloud.google.com/iam/docs/manage-access-service-accounts)、[ロールの権限定義](https://docs.cloud.google.com/iam/docs/roles-permissions/iam#iam.workloadIdentityUser)。本コードは委任チェーンなしで `generateIdToken` を呼びます。より狭いID token専用ロールの案もありますが、今回は既定のWIF標準ロールとcallerの資源権限分離を維持し、Token Creatorを追加しません。独立レビューでも実ID・コードとの不整合はありませんでした。

## 4. KOKOへの請求先リンク（完了・参照用）

### 確認済みの状態

10/8、本人の完了報告後、既存ログイン `arcer.jp@gmail.com` の請求先一覧にアクティブなアカウント1件、概要に **「無料トライアル アカウント」** と残クレジット/終了日の表示を確認しました。登録は完了済みで、やり直し不要です。個人の支払情報や請求先IDは本書へ記録しません。

10/8時点の[既存KOKOの請求先画面](https://console.cloud.google.com/billing/linkedaccount?project=koko-510318)は未リンクだったため、Codexが利用可能な請求先を選択して本人へ渡しました。**10/9の本人完了報告後、アカウント管理の「リンクされているプロジェクト」に `KOKO / koko-510318` が存在することを確認しました。リンクは完了済みです。** 同じ一覧にある `My First Project` は別プロジェクトで、KOKOを移したり、プール/サービスアカウントを作り直したり、別プロジェクトを削除したりする必要はありません。

### 実施済み手順（再操作不要）

1. 残した画面の見出しが **「プロジェクト『KOKO』の請求先アカウント設定」**、URLのprojectが `koko-510318` であることを確認します。`My First Project` の予算作成画面とは別タブです。
2. 選択値「請求先アカウント」は今回登録した無料トライアルのアカウントです。**今後のKOKOのGoogle Cloud利用分をこの請求先へ紐付ける**ことを確認して、「アカウントを設定」を押します。これだけでアプリを配備したり、8,000円の支出停止上限を作ったりはしません。
3. 再認証が必要な場合は本人が対応します。**有料アップグレード、フルアカウントの有効化、前払い、有料サポートは選びません。** 異なる請求先や追加契約が出たら止めます。
4. 本人の完了報告後にCodexが結果を読み取ります。10/9にリンク確認済み。API有効化・権限追加・秘密入力・配備はこの操作に含めません。

画面と[Google公式](https://docs.cloud.google.com/free/docs/free-cloud-features)（2026-10-08確認）は、無料トライアル中は有料アカウントへアップグレードしない限り請求されないと説明しています。10/9はリンク先でも無料トライアル表示を確認しました。期間/クレジット終了で資源が停止し、猶予期間後の削除リスクもあるため、継続運用前に残量・終了日・移行を再判断します。

[請求先リンクの公式手順](https://docs.cloud.google.com/billing/docs/how-to/modify-project)では、プロジェクトの利用費用が選択した請求先へ集計されます。取消しのために無断で請求先リンクを外しません。稼働後の課金無効化はサービス停止につながるため、取消対象・影響を再確認します。

利点は実接続試験のGoogle分の費用をクレジットで賄える可能性、欠点は期限/利用制限/終了時停止です。代替の有料請求先は継続性を得られる一方、利用分の支払いが発生します。現段階では無料試験を優先する提案であり、8,000円方針を有料契約の包括承認にはしません。Vercel/Cloudflare等の他社費用はこのクレジットの対象外です。

### 入力途中の予算画面について

10/8の未保存フォームは変更せず保全しました。10/9、リンク先請求アカウントの `Budgets & caps` は新規作成案内だけで、保存済み予算の一覧行はありませんでした。**8,000円の自動停止は未設定です。** [Spend caps公式仕様](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)（10/9確認）ではCloud Runも対象ですが、**1プロジェクト・1対象サービス・月単位**で、遅延による超過や継続資源の費用もあります。KOKO全サービス/他社込み8,000円の強制上限ではありません。対象と通知/停止金額は資源作成・実処理前に準備し、保存前に本人へ示します。

## 5. KOKOの4 API有効化（完了・参照用）

10/9、本人の「4 API有効化済み」の報告後、以下4件のmetrics画面で `KOKO`、API名、ステータス「有効」と「APIを無効にする」を確認しました。再操作不要です。以下は実施済み手順の参照であり、API有効化と資源作成/実配備を分けます。

| API               | 目的                                 | 有効化画面                                                                                                                           |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud Run Admin   | 画像処理コンテナーの実行基盤         | [run.googleapis.com](https://console.cloud.google.com/apis/library/run.googleapis.com?project=koko-510318)                           |
| Artifact Registry | 検証済みコンテナーの非公開保存       | [artifactregistry.googleapis.com](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com?project=koko-510318) |
| Cloud Vision      | 後続の必須SafeSearch/OCR検査         | [vision.googleapis.com](https://console.cloud.google.com/apis/library/vision.googleapis.com?project=koko-510318)                     |
| Secret Manager    | 後続のサーバー用秘密の保管・限定参照 | [secretmanager.googleapis.com](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com?project=koko-510318)       |

初回の処理OFFの起動準備に必要なのは上2件、下2件は後続の必須実処理向けです。有効化だけでは画像/秘密を登録・送信せず、実処理も開始しません。ただし利用可能なサービスが増え、Google管理service agent/ロールが自動作成されることがあります。10/7のIAM読取りを基点に有効化後の差分を確認し、APIによる自動追加と断定できないものは別途調査します。caller/runtimeへの手動ロール付与、APIキー作成、配備、画像解析、保存資源作成は別ゲートです。後続の保存・実行・解析には利用量に応じた費用/クレジット消費があり、有効化を費用全体のゼロ保証にはしません。

### 実施済みの本人操作（再操作不要）

1. 上表の4画面を順に開き、上部が **KOKO**、URL末尾が `project=koko-510318`、API名が表と一致することを確認します。
2. それぞれ **「有効にする」** を1回押します。表示される利用条件は本人が確認します。既に「管理」又は「APIが有効です」なら再操作不要です。
3. 有効化後の「認証情報を作成」、鍵発行、「デプロイ」「サービスを作成」、有料アップグレードは押しません。想定外の追加契約・権限要求・エラーがあれば、その項目だけ止めて知らせてください。
4. 完了後は **「4 API有効化済み」** と返信してください。秘密値・カード情報・JWTは不要です。Codexが結果と必要な次の非秘密設定を確認します。

WIFプールOFF、既存Access、API自動配備OFFは維持します。取り消す場合もAPIを無断無効化しません。特にArtifact Registryは無効化後のデータ削除リスクがあるため、影響を確認して別途判断します。

根拠：[Artifact Registryの有効化と無効化](https://docs.cloud.google.com/artifact-registry/docs/enable-service)、[Vision準備](https://docs.cloud.google.com/vision/docs/setup)、[Secret Manager有効化](https://docs.cloud.google.com/secret-manager/docs/configuring-secret-manager)、[Google管理service agents](https://docs.cloud.google.com/iam/docs/service-agents)。秘密は通常の平文入力欄へ置かず、[Cloud RunのSecret参照](https://docs.cloud.google.com/run/docs/configuring/services/secrets)を準備し、本人の秘密入力とruntimeへの限定権限は別ゲートにします。

## 6. 費用通知・検査・非公開保存先（完了・参照用）

対象はすべて **KOKO / `koko-510318`**。10/9、本人の「3件完了」報告後、保存済み予算、検査APIの有効状態、リポジトリの設定と空のimage一覧を読取り確認しました。**再保存・再作成は不要です。** 以下は実施済み設定の参照で、image送信・有料検査実行・配備の承認ではありません。

### A. Google分の早期費用通知を保存

保存済み `koko-google-monthly-alert` の編集画面で次の値を読み取り、変更・再保存はしていません。請求先IDはチャット/Gitへ貼り付けません。

| 項目           | 保存済み値                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| 種類・名前     | アラートのみ / `koko-google-monthly-alert`                                                     |
| 対象           | KOKOだけ、Googleの全サービス、月単位                                                           |
| 金額・実額通知 | 1,000円、500円/900円/1,000円で通知                                                             |
| クレジット     | プロモーションクレジットは計算から除外、無料枠は含める                                         |
| 通知先         | プロジェクトオーナーと既存の課金管理者・課金ユーザーの両方ON。追加メールチャネル・Pub/SubはOFF |

当初準備した通知先はオーナーだけでしたが、保存結果は両方ONでした。本人は一度オーナーだけへ戻すと回答し、その後**両方ONを維持**する最終方針へ変更しました。Codexはチェック変更・再保存を行っていません。既存ロールに応じた費用通知であり、新たな管理権限付与ではありません。

全社合計8,000円の準備方針を変更せず、Google分を早めに把握する通知です。無料トライアルのクレジットで利用額が隠れない設定です。**通知だけで課金を止めません。** 月の区切りは太平洋時間で、費用反映/通知には24時間以上の遅れもあり得ます。1,000円を超えない保証ではありません。[Google予算の公式説明](https://docs.cloud.google.com/billing/docs/how-to/budgets)

代替のSpend capは1サービスの停止制御には使えますが、他のGoogleサービスや他社費用をまとめて止められず、遅延・サービス停止の影響もあります。まず全Googleの通知を準備し、実処理前にサービス別上限/停止手順を別途確認します。通知先・金額の変更や削除は後から可能ですが、既に発生した利用料を取り消す機能ではありません。

### B. コンテナーの脆弱性検査を有効化

[Container Scanning API](https://console.cloud.google.com/apis/api/containerscanning.googleapis.com/empty?project=koko-510318)で、KOKO・API名・有効状態を確認済みです。写真のAI判定ではなく、実行プログラムに含まれる既知の脆弱性を調べます。まだimage未送信のため、クラウド検査の実行・結果確認は未実施です。

- 公式単価は**新しいimage digestの初回検査1件につき$0.26**。仮に1ドル150円なら約39円、1〜5版なら約39〜195円。税・為替で変わり、上限保証ではありません。同じdigestの再検査は追加課金されません。[Artifact Analysis料金](https://cloud.google.com/artifact-analysis/pricing)
- API有効化後、スキャン対象リポジトリへのimage送信で検査/費用が発生します。project単位の有効化であり、今後の別リポジトリも設定を確認します。今回は下記1件を作成済み、image送信なしです。
- npm auditだけではOS依存の検査を十分に代替できないため、セキュリティ優先で追加します。利点は配備前の検出、欠点は版ごとの費用と確認作業です。検査で重大な問題が出たら修正し、検査成功だけで安全性全体を保証しません。
- 有効化済みAPIを無断で無効化しません。既発生の費用を取り消す機能ではありません。

### C. 実行プログラムの非公開保存先を作成

[Artifact Registryのkoko-images](https://console.cloud.google.com/artifacts/docker/koko-510318/asia-northeast1/koko-images?project=koko-510318)で次を確認済みです。**投稿写真・動画の保存先ではなく、画像処理プログラムの保管庫**です。編集画面は読取りのみで戻り、設定変更していません。

| 項目                 | 指定値                                                    |
| -------------------- | --------------------------------------------------------- |
| 名前・形式・モード   | `koko-images` / Docker / 標準                             |
| 場所                 | リージョン `asia-northeast1 (東京)`                       |
| 説明                 | `KOKO private image-service containers; deploy by digest` |
| 暗号化               | Googleが管理する暗号鍵                                    |
| 不変のイメージタグ   | 有効（同じタグで別版に上書きしない）                      |
| クリーンアップ       | テストを実行、ポリシー追加なし。自動削除なし              |
| プラットフォームログ | プロジェクト設定を継承。今回overrideしない                |
| 脆弱性スキャン       | 有効。再読込み後、詳細の「アクティブ」も確認              |

作成後も匿名公開権限を追加しません。ただし既存project IAMの継承は残り、専用アカウント2件だけがアクセスできる意味ではありません。保存は請求先合計0.5GiB/月まで無料枠、超過分は約$0.10/GiB・月。仮に全体で平均2GiBを30日保存すると約$0.15、仮150円/USDで約23円で、検査/転送は別です。将来の実サイズ・保持版数で再計算します。[Artifact Registry料金](https://cloud.google.com/artifact-registry/pricing)

東京は予定Cloud Runと同一地域に合わせる選択です。不変タグは誤上書きを防ぐ一方、タグ付きimageの削除にも制約があります。取り消すために保存済みimageやリポジトリを無断削除せず、データと配備の参照先を確認します。[作成と不変タグの公式手順](https://docs.cloud.google.com/artifact-registry/docs/repositories/create-repos)

### 標準アカウントの注意

10/9のproject IAM読取りで**標準ComputeサービスアカウントにEditor**を確認しました。本人は他アプリ利用の有無を「分かりません」と回答。Cloud Runサービス一覧は空でしたが、Compute Engine APIは無効でVM一覧を確認できず、他依存先がないとは断定できません。調査だけのためにAPIを有効化せず、既存権限も削除しません。**KOKO runtimeに標準アカウントを使わず、専用の `koko-image-runtime` を指定**します。Editorの整理は依存先/影響を確認した別の本人ゲートとし、Google管理service agentsを一括削除しません。[Googleの権限最小化手順](https://docs.cloud.google.com/compute/docs/access/service-accounts)

3件は確認済みです。コンテナー送信、Cloud Run作成/配備、秘密登録、IAM変更、プールONは未実施です。リモートdigestと配備対象が確定していないため、仮の公開imageでCloud Runを先に作らないでください。

## 7. 今すること：Google CLIへ本人ログイン

### 準備済みのことと認証の影響

10/9、公式Google Cloud CLI **588.0.0** のWindows x86_64・Python同梱archiveを `tmp/tooling/google-cloud-sdk-588.0.0/` へ展開しました。公式SHA-256と一致し、空の隔離設定で `--version` を確認済みです。Windows PATH・既存CLI設定・Docker認証を変更せず、管理者用インストーラーも実行していません。別PCではこの作業フォルダーは共有されないため、同じ準備が必要です。

本人ログインはブラウザのログインとは別です。**このPCのGoogle CLIへ、選択するGoogleアカウントの資格情報を保存します。CLIはそのアカウントが元から持つ権限で操作でき、KOKOだけに権限を限定するログインではありません。** `--no-activate` は既定の有効アカウント切替を抑えるもので、権限を狭める指定ではありません。以後の操作は明示したアカウントと `--project=koko-510318` に固定して確認します。

### 本人が行うこと（管理者PowerShellは不要）

1. 通常のPowerShellでKOKOルートを開き、次を実行します。

   ```powershell
   & .\tmp\tooling\google-cloud-sdk-588.0.0\google-cloud-sdk\bin\gcloud.cmd auth login arcer.jp@gmail.com --no-launch-browser --no-activate
   ```

2. 表示されるログインURLを自分のブラウザで開き、**`arcer.jp@gmail.com` とGoogle Cloud CLI**を確認して本人がログイン・許可します。別アカウント、支払、サービスアカウント鍵、想定外の追加権限が出たら確定せず知らせてください。
3. 確認コードが出たら、**自分のPowerShellへだけ**貼り付けます。ログインURL・コード・token・認証画面をチャット/Git/共有資料へ送らないでください。成功後は **「Google CLIログイン完了」** とだけ返信します。

`gcloud init`、`application-default login`、`--update-adc`、JSON鍵発行、Dockerへの認証登録、image送信、配備は今は行いません。今回は本人ログインまでで、クラウド利用・課金・IAM変更・実配備の包括承認ではありません。不要になった認証の取消しは、そのアカウントと依存作業を確認して別途行います。

Codexは既に固定ソースからserviceコンテナーを作り、非root・外部通信なしでhealthの処理OFF応答と処理ルートの拒否を検証しました。リモートへの送信・クラウド脆弱性検査・Cloud Run起動・WIF実認証は未検証です。本人ログイン後、固定SHA・送信先・回数・費用を示して次の送信操作を分離します。

根拠（2026-10-09確認）：[公式versioned archiveとchecksum](https://docs.cloud.google.com/sdk/docs/downloads-versioned-archives)、[gcloud auth loginの公式仕様](https://docs.cloud.google.com/sdk/gcloud/reference/auth/login)、[Artifact Registryの認証方式](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication)。SA長期鍵による代用はしません。

## 8. 今は操作しない後続工程

コードと実際の対象が確定してから、別途本人へ案内します。今の作成作業と混ぜません。

1. 第1〜6節は完了。第7節の本人ログイン後、Codexがアカウント・対象・固定SHAを照合し、コンテナー送信・digest・処理OFFの初回配備案と費用/停止条件を準備します。送信と初回配備は別ゲートで、ブラウザログインだけでCLI認証済みとしません。画面保存と実token交換の成功を区別します。
2. caller/runtimeのメール・数値IDを環境別設定へ反映する準備をします。runtimeやプロジェクト番号をcaller subjectとして代用しません。登録先・費用・停止方法を提示し、実保存は別ゲートにします。
3. 画像Cloud Run **1サービス上だけ**で、callerに`roles/run.invoker`を付与。全利用者・全認証利用者は許可しません。別のruntimeアカウントがVision等の処理権限を持ちます。
4. Worker→固定Vercel中継の専用認証を本人が登録。既存Access/Supabase/CSRFの秘密を再利用せず、期限/更新/漏洩時の停止方法を確認します。
5. VercelのAll Deployments保護を維持して機械アクセスを構成。automation bypass secretを使う場合、**koko-webの保護付き配備へアクセスできる秘密で、画像routeだけに限定された資格情報ではない**ことを説明し、別途本人確認します。今は発行・入力・保護解除しません。
6. 明示した対象への配備・プール有効化・consumer有効化を本人ゲートで実施。productionだけを信頼するので、未承認のPreviewを実認証試験に使いません。
7. 未認証/別project/preview/別aud/期限切れ/任意URL/署名不正/重複の拒否、IAMとアプリ両方の主体検査、実DBの現行job/lease、停止時の非公開保留を受入試験します。モック成功からIAM成功を推定しません。

中継が1段増え、遅延・可用性・Function利用量の負担があります。画像/動画そのものは中継せず3 UUIDだけを渡しますが、待受時間の利用量はゼロと見なしません。有限timeout・Queue再配送・冪等性を実装し、実測で費用と処理時間を確認します。[Functionsの上限](https://vercel.com/docs/functions/limitations)、[GoogleのWIFによるCloud Run認証](https://docs.cloud.google.com/iam/docs/tutorial-cloud-run-workload-id-federation)

## プライバシーポリシー

2026-10-06に全文を受領しました。本人の確認により、削除申出・最低年齢を利用規約に統一し、確認済みの外部送信等を最小追記します。**再送は不要です。** 実契約・国外取扱い・保存削除基準の確認、イベントへの版の紐付け、公開・実同意受付の受入は本文受領とは別です。未確定事項を補って公開せず、独立したコード実装・自動検査を続けます。
