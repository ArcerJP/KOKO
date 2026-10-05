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

合成RSA/JWKS、期限・別主体・別aud・通信失敗・上限・Node loopback・模擬DB/runnerを試験。成功は画像段階に限定し、Queue ACK/公開を許可しません。実Cloud Runのheader伝搬、IAM、token取得方式、複数instance quota、実DB/R2、実機は未検証。JWTの失効は有効期限とIAMの両方を考慮し、アプリ内検証だけで即時失効を保証しません。

サービス作成/課金/権限/鍵/Secret/配備をこのADRのAccepted状態から実行しません。実接続前に許可主体とIAM設定、短命tokenの取得方式を確認し、必要な本人操作を分離します。

## 一次資料（2026-10-06確認）

- [Cloud Runのサービス間認証](https://cloud.google.com/run/docs/authenticating/service-to-service)：ID tokenのaudとAuthorization、X-Serverless-Authorizationの違い。
- [Cloud Run service URL](https://docs.cloud.google.com/run/docs/triggering/https-request)：run.appの現行/非決定的形式。識別子を固定形式と決めつけない。
- [joseのJWKS検証](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)：固定JWKS・cache/cooldownと署名鍵の選択。
