# ADR-0005: 固定開発APIへのサーバー専用Accessサービス認証

- 状態：Accepted（採用設計。実適用・未完了の状態は[クラウド準備](../product/cloud-setup.md#webからのaccessサービス認証2026-10-04)を参照）
- 日付：2026-10-04
- 判断：採択済み自律進行方針の範囲で選定。人間による権限変更の承認ではない。

## 背景

本人情報3操作のNext.js中継は、ブラウザのWorker用Accessセッションを継承できません。開発Workerの保護を維持した接続が必要です。利用者のGoogle認証・Cookie/CSRF・DB認可と、開発用Accessを分離します。

## 決定

既存の固定開発Workerだけへ、Webサーバー設定からAccess service tokenの2headerを付与します。ブラウザからは取得せず、Node専用の中継モジュールに`server-only`を付けます。設定不足は通信前に拒否し、資格情報なしへのfallback、任意転送先、redirect追跡、メディア中継は追加しません。

実環境では対象applicationの個別tokenに限定したService Auth policyが必要ですが、本ADR自体を作成・許可済みの証拠とはしません。全URL保護と既存本人policyを維持し、公開化やBypass、組織全体設定変更を前提にしません。具体的な設定・制約・本人ゲートの正本は[Web README](../../apps/web/README.md#accessサービス認証)、適用済み状態は[クラウド準備](../product/cloud-setup.md)です。

## 比較

| 方式                        | 利点                                          | 欠点・判断                                                    |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| サーバー専用service token   | 固定HTTPS中継へ追加でき、利用者資格情報と分離 | 保管・期限更新・対象policy管理が必要。ローカル準備として採用  |
| ブラウザAccess Cookieの転送 | 既存の本人Access loginを使えるように見える    | origin/期限の違いと秘密漏洩、サーバー認証への依存。採用しない |
| Access保護解除/Bypass       | 中継の認証設定が不要                          | 開発APIのアクセス境界を弱める。採用しない                     |
| mTLS                        | 証明書ベースのサービス認証                    | 証明書・更新・実行基盤の確認が増える。現段階では採用しない    |

service tokenは外周の通過能力を持ちますが、アプリの利用者権限を付与しません。Workerは引き続きJWT・イベント所属・CSRF・規約・BAN等を検査します。配備用Cloudflare token・Supabase secretの流用はしません。新プラン・追加課金の採択も含みません。

## 検証と制約

合成資格情報で固定転送先/3操作、偽装header非採用、欠落/不正設定、応答への反射拒否、redirect/異常/時間/容量制限、本人CookieとCSRFの回帰を検査します。Nextのサーバー境界はproduction buildでも確認し、Node単体試験のmarker aliasを実buildへ適用しません。

既定OFFを維持し、正式本文採択、実token作成、Secret登録、Access policy、DB適用、実配備/有効化、実Googleセッションでの通し受入は別ゲートです。既存実装へのrevertは通常PRで可能ですが、実適用後の失効/停止には利用者影響と残存Cookie/JWTを含む確認が必要です。

## 公式根拠

2026-10-04確認：[Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[Service Auth等のpolicy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)、[Next.js server-only境界](https://nextjs.org/docs/app/getting-started/server-and-client-components)、[Next.js環境変数](https://nextjs.org/docs/app/guides/environment-variables)。
