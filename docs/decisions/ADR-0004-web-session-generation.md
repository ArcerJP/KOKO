# ADR-0004: Web API Cookieのログイン世代と終了処理

## 状態

Accepted（2026-10-04）。既定無効のローカル実装について、[自律進行方針](../../AGENTS.md#作業進行と承認境界)の範囲で採用。実環境の認証設定・有効化・配備・人間のPR承認を意味しません。

## 背景

ブラウザのSupabase signOutだけでは別のAPI Cookieが残ります。Cookie削除を追加しても、先に開始した発行要求の応答が後着すると再設定されます。別ログイン後に旧SSR refresh応答が届く場合も考慮が必要です。SupabaseのJWTはsignOut後も期限まで残り得るため、削除と即時失効を区別します。

## 決定

Web専用のHttpOnly世代Cookieと、同じ世代を含むAPI Cookieを組み合わせます。成功Google callbackでランダム世代を生成し、検証済み本人・Authセッションのfingerprintへ結び付けます。発行処理は要求の世代を更新せず、同じAuthセッションからだけAPI Cookieを発行します。中継は現在世代との一致を検査し、既存Workerへraw JWTだけを渡します。

ログアウトは世代終了・API Cookie消去のWeb routeを呼び、失敗時も既存Supabase signOutを試します。両方の成功だけを完了として扱い、自動再送はしません。既定無効時の既存ログイン/ログアウトを維持します。形式・期限・入力検査・失敗時動作は[Web README](../../apps/web/README.md#api用cookieを含むログアウト既定無効)だけを仕様正本とします。

## 検討した代替案

- API Cookieの削除のみ：変更量は小さいものの、遅延した発行応答で復活するため不採用。
- タブ内のJS lockのみ：軽量ですが、別タブ・ナビゲーション・旧応答を覆えません。二重押下抑止としてのみ併用。
- サーバー側の失効台帳：盗難JWTの失効にも対応可能ですが、共有ストア・認可方式・DB運用と各要求の照会が増えます。今回は通常ブラウザの順序問題に限定し、新規クラウド資源を増やさない方式を採用。即時失効要件を満たす代替だとは扱いません。

## 影響

追加依存・鍵・DB・Worker契約変更はありません。世代は認証署名ではなく、JWT検証/認可を省略できません。JWT盗難・XSS・既送信要求の取消し・全端末のCookie削除・同時OAuthの禁止は保証しません。hashも匿名化保証ではありません。

Web Cookie形式は変更され、旧形式へfallbackしません。まだ実有効化していないため、有効化前に関連コードを揃え、本人の新規ログインと複数タブ/refresh/終了の受入を実施します。ローカル合成試験はSDK・実ブラウザ・実クラウドの受入と区別します。取り消す場合は通常PRで発行/中継/callback/終了を一組として戻し、将来の有効環境では先に残存Cookieと停止手順を個別確認します。

## 参照資料

- [現在の構成](../architecture/product-architecture.md)、[開発計画](../product/development-plan.md)。
- [Supabase signOut](https://supabase.com/docs/reference/javascript/auth-signout)：scopeとJWT失効の制約。
- [Supabase JWT fields](https://supabase.com/docs/guides/auth/jwt-fields)：本人subとsession_id。
- [Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies)：routeのCookie書込み境界。
