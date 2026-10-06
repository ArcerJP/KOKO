# 処理サービスの共有コア

`@koko/processing`はWorkerとVercel server-only中継が共有する、固定宛先の処理認証・HTTPプリミティブです。公開API契約は`@koko/contract`、DB認可はAPI/画像サービスへ残します。Node/Next/Cloud SDKや環境変数読取りをこのpackageへ持ち込まず、注入したWeb APIだけを使います。

- `cloud-run-client`：固定Google STS→IAM ID token→private Cloud Run。ローカルclaim解析は追加検査であり、署名検証はGoogleが担います。
- `relay`：固定Vercel origin/path・event・3 UUID、専用HMAC、60秒時刻窓、本文512 bytes、redirect拒否、有限timeoutとabort。
- HMAC署名のorigin/time/nonce/本文を照合しますが、永続nonce台帳ではありません。同じjobの短期再送はDBのlease・投稿版・冪等処理で防御します。
- HTTP200は完了主張にとどまり、Queueは独立したDB完了証拠でACKします。署名やupstream応答をlog/公開応答へ返しません。

`npm.cmd run build:processing`で生成、`build:shared`で契約とともに生成します。dist・実token・鍵・画像は追跡しません。既存のAPI/Web試験が共有コードの否定ケースと全経路を検証します。設定の正本は[Web README](../../apps/web/README.md#cloud-run固定中継既定off)、採用理由と実環境の制約は[ADR-0007](../../docs/decisions/ADR-0007-private-image-service.md)です。実IAM・配備・受入はローカル試験とは別です。
