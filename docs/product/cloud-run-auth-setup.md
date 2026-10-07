# Cloud Run認証の準備（本人操作）

更新日：2026-10-07。採用理由は[ADR-0007](../decisions/ADR-0007-private-image-service.md)、現物確認は[cloud-setup](cloud-setup.md#2026-10-07のwif保存条件と次の本人操作)を参照します。**中継コードとQueue接続はローカル実装済み、実接続は未受入です。**

## 今の目的と影響

Googleの長期秘密鍵を作らず、既存Vercelの署名IDから短命のGoogle ID tokenを取得する準備です。**第1〜3節は本人の作成・保存後に照合済み。やり直し不要です。今する作業は第4節の無料トライアル登録だけです。** 現在KOKOプロジェクトに請求先がなく、画像処理の実接続へ進めません。Codexが申込み画面まで開き、国「日本」と対象アカウントを照合しました。契約同意・本人/支払情報の入力・最終登録は本人が行います。プールON、Cloud Runの公開化、Secret登録、実配備は含みません。

APIの初期化時に有効化されたサービスはcloud-setupを参照してください。今回指定した第4節の無料登録以外で、カード・請求・有料契約を求められたら、その先へ進まず画面の名称だけ知らせてください。秘密は送らないでください。

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

## 4. 今すること：無料トライアルの本人登録

### 確認済みの状態

10/7、`KOKO / koko-510318` の請求先画面に「このプロジェクトには請求先アカウントがありません」と表示されました。現在のログインでの請求先一覧も追加案内のみです。別名義・別ログインの請求先まで存在しないとは断定しません。開いた登録画面は **「Google Cloud を無料で試す」「ステップ1/2」**、アカウント `arcer.jp@gmail.com`、国「日本」。Codexは「同意して続行」を押していません。

### 本人が今行うこと

1. 開いている無料トライアル登録画面で、上記アカウント・国と利用規約を確認し、同意する場合に **「同意して続行」** を押します。
2. 続く本人情報・支払方法・本人認証は本人が入力し、無料トライアルの最終登録まで行います。値はチャット・Git・スクリーンショットに送らないでください。第2画面は未閲覧なので、項目名や最終ボタン名は推測しません。
3. **従量課金へのアップグレード、フルアカウントの有効化、前払い、有料サポートの購入は選びません。** 無料トライアルが使えない・有料申込みしか表示されない場合は、その事実だけ知らせて止めます。
4. 完了したら **「Google Cloud無料トライアル登録済み」** と返信してください。KOKOへの請求先リンクはCodexが確認し、必要なら非秘密の選択まで準備して、最後のリンク確定だけ別途本人へ渡します。自動作成された別プロジェクトへKOKOを移しません。

画面と[Google公式](https://docs.cloud.google.com/free/docs/free-cloud-features)（2026-10-07確認）は、対象者の無料トライアルを90日/$300クレジット、自動請求なしと説明しています。申込みには本人/支払方法確認があります。**表示されたオファーと審査・登録成功は別**で、現時点では適用済みと扱いません。有料化しない場合、期間/クレジット終了で資源が停止し、猶予期間後の削除リスクもあるため、継続運用前に残量・終了日・移行を再判断します。

利点は実接続試験のGoogle分の費用をクレジットで賄える可能性、欠点は期限/利用制限/終了時停止です。代替の有料請求先は継続性を得られる一方、利用分の支払いが発生します。現段階では無料試験を優先する提案であり、8,000円方針を有料契約の包括承認にはしません。Vercel/Cloudflare等の他社費用はこのクレジットの対象外です。

### Codexが準備した次のAPI（今は押さない）

以下4件はいずれも10/7のlibrary画面に「有効にする」を確認しました。請求先の確認後に対象をまとめて提示します。Cloud Runの作成リンクには `enableapi=true` があるため、読取りのつもりで踏まず、API有効化と実配備を分けます。

| API               | 目的                                 | 有効化画面                                                                                                                           |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud Run Admin   | 画像処理コンテナーの実行基盤         | [run.googleapis.com](https://console.cloud.google.com/apis/library/run.googleapis.com?project=koko-510318)                           |
| Artifact Registry | 検証済みコンテナーの非公開保存       | [artifactregistry.googleapis.com](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com?project=koko-510318) |
| Cloud Vision      | 後続の必須SafeSearch/OCR検査         | [vision.googleapis.com](https://console.cloud.google.com/apis/library/vision.googleapis.com?project=koko-510318)                     |
| Secret Manager    | 後続のサーバー用秘密の保管・限定参照 | [secretmanager.googleapis.com](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com?project=koko-510318)       |

初回の処理OFFの起動準備に必要なのは上2件、下2件は実処理向けです。有効化だけで画像や秘密を登録・送信するわけではありませんが、Google管理service agent/ロールが自動作成されることがあるため前後を照合します。caller/runtimeへの手動ロール付与、APIキー作成、配備、画像解析、保存資源の作成とは別操作です。停止を理由にAPIを無断無効化しません。特にArtifact Registryは無効化後のデータ削除リスクがあります。

根拠：[Artifact Registryの有効化と無効化](https://docs.cloud.google.com/artifact-registry/docs/enable-service)、[Vision準備](https://docs.cloud.google.com/vision/docs/setup)、[Secret Manager有効化](https://docs.cloud.google.com/secret-manager/docs/configuring-secret-manager)、[Google管理service agents](https://docs.cloud.google.com/iam/docs/service-agents)。秘密は通常の平文入力欄へ置かず、[Cloud RunのSecret参照](https://docs.cloud.google.com/run/docs/configuring/services/secrets)を準備し、本人の秘密入力とruntimeへの限定権限は別ゲートにします。

## 5. 今は操作しない後続工程

コードと実際の対象が確定してから、別途本人へ案内します。今の作成作業と混ぜません。

1. 第3節の保存確認は完了。第4節の登録後、KOKOへの請求先リンク・API状態・有効化の影響をCodexが確認します。画面保存と実token交換の成功を区別します。
2. caller/runtimeのメール・数値IDを環境別設定へ反映する準備をします。runtimeやプロジェクト番号をcaller subjectとして代用しません。登録先・費用・停止方法を提示し、実保存は別ゲートにします。
3. 画像Cloud Run **1サービス上だけ**で、callerに`roles/run.invoker`を付与。全利用者・全認証利用者は許可しません。別のruntimeアカウントがVision等の処理権限を持ちます。
4. Worker→固定Vercel中継の専用認証を本人が登録。既存Access/Supabase/CSRFの秘密を再利用せず、期限/更新/漏洩時の停止方法を確認します。
5. VercelのAll Deployments保護を維持して機械アクセスを構成。automation bypass secretを使う場合、**koko-webの保護付き配備へアクセスできる秘密で、画像routeだけに限定された資格情報ではない**ことを説明し、別途本人確認します。今は発行・入力・保護解除しません。
6. 明示した対象への配備・プール有効化・consumer有効化を本人ゲートで実施。productionだけを信頼するので、未承認のPreviewを実認証試験に使いません。
7. 未認証/別project/preview/別aud/期限切れ/任意URL/署名不正/重複の拒否、IAMとアプリ両方の主体検査、実DBの現行job/lease、停止時の非公開保留を受入試験します。モック成功からIAM成功を推定しません。

中継が1段増え、遅延・可用性・Function利用量の負担があります。画像/動画そのものは中継せず3 UUIDだけを渡しますが、待受時間の利用量はゼロと見なしません。有限timeout・Queue再配送・冪等性を実装し、実測で費用と処理時間を確認します。[Functionsの上限](https://vercel.com/docs/functions/limitations)、[GoogleのWIFによるCloud Run認証](https://docs.cloud.google.com/iam/docs/tutorial-cloud-run-workload-id-federation)

## プライバシーポリシー

2026-10-06に全文を受領しました。本人の確認により、削除申出・最低年齢を利用規約に統一し、確認済みの外部送信等を最小追記します。**再送は不要です。** 実契約・国外取扱い・保存削除基準の確認、イベントへの版の紐付け、公開・実同意受付の受入は本文受領とは別です。未確定事項を補って公開せず、独立したコード実装・自動検査を続けます。
