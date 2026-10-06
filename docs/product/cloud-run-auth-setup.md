# Cloud Run認証の準備（本人操作）

更新日：2026-10-06。採用理由は[ADR-0007](../decisions/ADR-0007-private-image-service.md)、実適用の記録は[cloud-setup](cloud-setup.md#2026-10-06の認証準備とpreview停止確認)を参照します。**中継コードとQueue接続はローカル実装済み、実接続は未受入です。**

## 今の目的と影響

Googleの長期秘密鍵を作らず、既存Vercelの署名IDから短命のGoogle ID tokenを取得する準備です。今は**無効なWIFプールとproviderの作成だけ**を本人が行います。Cloud Runの公開化、IAM権限付与、Secret登録、課金、配備は行いません。プール作成だけで画像処理が動くわけではありません。

APIの初期化時に有効化されたサービスはcloud-setupを参照してください。カード・請求・有料契約の画面が出たら、その先へ進まず画面の名称だけ知らせてください。秘密は送らないでください。

非秘密の入力準備と画面上の照合は、依頼を受けたCodexが担当できます。最後の保存と、その後のIAM・秘密・有効化・配備は本人ゲートを維持します。未保存フォームの入力完了をプール作成済みと扱いません。

## 1. Google Cloudでプールを作成

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

## 2. 今は操作しない後続工程

コードと実際の対象が確定してから、別途本人へ案内します。今の作成作業と混ぜません。

1. 鍵なしcallerサービスアカウント`koko-cloud-run-caller`を作成。作成時のprojectロールは空にし、Vision/Storage/Editor/Ownerを付けません。
2. **そのcaller上だけ**で、productionの完全なsubjectを持つprincipalに`roles/iam.workloadIdentityUser`を付与。プール全体の`principalSet/*`は使いません。授権直前にプロジェクト番号と対象を再確認します。
3. 画像Cloud Run **1サービス上だけ**で、callerに`roles/run.invoker`を付与。全利用者・全認証利用者は許可しません。別のruntimeアカウントがVision等の処理権限を持ちます。
4. Worker→固定Vercel中継の専用認証を本人が登録。既存Access/Supabase/CSRFの秘密を再利用せず、期限/更新/漏洩時の停止方法を確認します。
5. VercelのAll Deployments保護を維持して機械アクセスを構成。automation bypass secretを使う場合、**koko-webの保護付き配備へアクセスできる秘密で、画像routeだけに限定された資格情報ではない**ことを説明し、別途本人確認します。今は発行・入力・保護解除しません。
6. 明示した対象への配備・プール有効化・consumer有効化を本人ゲートで実施。productionだけを信頼するので、未承認のPreviewを実認証試験に使いません。
7. 未認証/別project/preview/別aud/期限切れ/任意URL/署名不正/重複の拒否、IAMとアプリ両方の主体検査、実DBの現行job/lease、停止時の非公開保留を受入試験します。モック成功からIAM成功を推定しません。

中継が1段増え、遅延・可用性・Function利用量の負担があります。画像/動画そのものは中継せず3 UUIDだけを渡しますが、待受時間の利用量はゼロと見なしません。有限timeout・Queue再配送・冪等性を実装し、実測で費用と処理時間を確認します。[Functionsの上限](https://vercel.com/docs/functions/limitations)、[GoogleのWIFによるCloud Run認証](https://docs.cloud.google.com/iam/docs/tutorial-cloud-run-workload-id-federation)

## プライバシーポリシー

2026-10-06に全文を受領しました。本人の確認により、削除申出・最低年齢を利用規約に統一し、確認済みの外部送信等を最小追記します。**再送は不要です。** 実契約・国外取扱い・保存削除基準の確認、イベントへの版の紐付け、公開・実同意受付の受入は本文受領とは別です。未確定事項を補って公開せず、独立したコード実装・自動検査を続けます。
