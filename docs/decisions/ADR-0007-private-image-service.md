# ADR-0007: 画像処理の非公開HTTPとGoogleサービス主体の検証

- 状態：Accepted（ローカル実装。実IAM/認証追加/配備は別の本人ゲート）
- 日付：2026-10-06
- 判断：採用済みCloud Run構成を具体化する自律的な技術判断。

## 背景

既存画像runnerはDBのjob/lease/投稿版を検査しますが、呼出元の認証ではありません。Queue consumerから呼ぶ前に、DB権限を持つ画像サービスへの外部入口を限定する必要があります。画像記録成功をAI判定・全処理完了と誤認してはいけません。

## 決定

Cloud Runのprivate IAM invokerを前提とし、アプリもGoogle署名ID tokenのRS256・issuer・service audience・許可service accountのemail/sub・期限を検証します。宛先は信頼する設定の実run.app originと完全一致し、受信Host/URLから決めません。検証には固定版joseを使い、自作JWT暗号実装を避けます。

HTTPは固定route・3 UUIDだけ。認証後に本文を有限読取りし、既存DB/runnerが最新の業務認可を再確認。応答には画像、plan、秘密、provider例外を載せません。CLIとHTTPのDocker targetを分け、HTTPも既定OFFにします。一般Web APIや共有契約へNode依存を追加しません。

## 比較と影響

| 案                                       | 利点                                         | 欠点・判断                                         |
| ---------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| private IAM＋アプリのGoogle署名/主体照合 | 短命token、誤ったinvoker追加に対する多層防御 | JWKS通信と構成が必要。採用                         |
| IAMだけで本文を信頼                      | 小さい実装                                   | ローカルや誤公開設定で認証が消える。単独では不採用 |
| 固定共有Bearer秘密                       | 導入が簡単                                   | 長期秘密の配布・失効、主体の識別が弱い。不採用     |
| 任意URL/画像をHTTPへ直接送る             | 汎用性                                       | SSRF・大きな入力・DB境界迂回。不採用               |

新しいトップレベル領域/Skillは不要です。公開可能な実装はapps/image、運用仕様は同README、今回の作業計画・試験記録はPrivateのタスクへ分離します。ライフサイクルは画像サービス本体と一緒に更新/廃止し、CLIや変換コアを複製しません。AI環境の可搬性には変更ありません。

## 制約と検証

合成RSA/JWKS、期限・別主体・別aud・通信失敗・上限・Node loopback・模擬DB/runnerを試験。画像段階の成功だけでQueue ACK/公開を許可しません。実Cloud Runのheader伝搬、IAM、token取得方式、複数instance quota、実DB/R2、実機は未検証。JWTの失効は有効期限とIAMの両方を考慮し、アプリ内検証だけで即時失効を保証しません。

同日の後続実装で、画像専用routeを維持したまま、画像/動画3フレームからAI合議とDB完了記録まで進める固定`/internal/process`を追加しました。Queue consumerはHTTP成功とは別にDBの現行job/投稿版・完了証拠を再取得してACKを判断します。処理失敗の保留もAI違反や公開成功に置き換えません。

WIFのSTS交換・サービスアカウントID token取得・固定Cloud Run呼出しを、Worker/Web共用の`packages/processing`へ移しました。Worker自身がambientなGoogle認証を持つとは仮定せず、実runtimeは固定Vercel中継だけを呼び、未構成なら拒否します。API内の旧moduleは互換exportだけで、実装を複製しません。

### 呼出元の方式選定（2026-10-06）

本人から速度・長期利用・セキュリティを比較して選定する依頼を受け、セキュリティを優先して**既存VercelのTeam OIDCをGoogle WIFへ交換する方式**を選定します。GoogleのサービスアカウントJSON秘密鍵は発行しません。Cloudflare AccessのサービスJWTを通常利用者JWTと同一視せず、空のsub・aud配列・strict service authenticationのCookie非発行を無視して発行源にしません。

Cloudflare Queue consumer → 専用HMAC認証の固定Vercel中継 → Google STS/IAM → private Cloud Runの順です。既存`apps/web`のserver-only routeをローカル実装し、任意URL・任意aud・任意サービスアカウント・画像本文を受け付けず、固定処理routeと3 UUIDだけを転送します。Vercel/Google tokenをWorker・ブラウザ・応答・ログへ返さず、Cloud RunとDBの認可・lease・完了証拠を維持します。実IAM/配備/サービス間受入は未完了です。

Googleはissuer・audに加えてVercelの固有project IDとproduction subjectを照合します。Preview/developmentやプール全体への権限を許可せず、専用callerに対象Cloud Run 1サービスのinvokerだけを付与する方針です。callerとVision等の処理用runtimeアカウントを分離します。

代案のGoogle秘密鍵は直結が簡単な反面、長期署名鍵の配布・漏洩時の失効・定期更新が必要です。WIFはその鍵を持たない利点がありますが、中継の可用性・有限timeout・追加Function利用量と、Worker→中継の別用途認証秘密の管理が増えます。完全な秘密情報ゼロ、無料、直結と同じ速度とは主張しません。

既存のAll Deployments保護を外しません。中継への機械アクセスには別の本人ゲートが必要で、Vercelのautomation bypass secretは単一routeだけの権限ではありません。保護付き接続・秘密の登録・プール有効化/IAM授権・実配備は、範囲とリスクを示して本人へ渡します。準備手順と停止点は[Cloud Run認証の準備](../product/cloud-run-auth-setup.md)を正本とします。

サービス作成/課金/権限/鍵/Secret/配備をこのADRのAccepted状態から実行しません。実接続前に許可主体とIAM設定、短命tokenの取得方式を確認し、必要な本人操作を分離します。

## 一次資料（2026-10-06確認）

- [Cloud Runのサービス間認証](https://cloud.google.com/run/docs/authenticating/service-to-service)：ID tokenのaudとAuthorization、X-Serverless-Authorizationの違い。
- [Cloud Run service URL](https://docs.cloud.google.com/run/docs/triggering/https-request)：run.appの現行/非決定的形式。識別子を固定形式と決めつけない。
- [joseのJWKS検証](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)：固定JWKS・cache/cooldownと署名鍵の選択。
- [VercelとGoogle WIF](https://vercel.com/docs/oidc/gcp)、[OIDCのclaim](https://vercel.com/docs/oidc/reference)：既存署名主体と固定issuer/aud/project/environment。
- [Google WIFの他provider設定](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)：限定主体のmapping/conditionとservice account impersonation。
- [Cloudflare service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[service JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)：通常利用者JWTとの違い。
- [Vercel automation bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)：保護と機械アクセスの境界。
