# ADR-0001: プロダクトと第0日の基盤選定

## 状態

Accepted（選定2026-09-21、契約一式の承認2026-09-22、iijima）。[第0日](../product/day-zero.md)に合意を記録。本番環境への適用は後続の別ゲートです。

## 背景

ワークスペースだけの状態に、要件定義書v0.7・開発計画v1.0を適用し、9/21〜9/22のキックオフ契約を作成する依頼を受けました。資料内の未決環境と通報・BANの差を確認しました。

## 決定

- 対象は第49回技科大祭の写真・動画共有Webアプリ。TypeScript、Next.js App Router、Supabase、R2、Stream、Queuesを資料の構成として採用。
- ユーザーがFE＝Vercel、API＝Cloudflare Workers、画像変換＝Google Cloud RunのNode.jsコンテナを選択。
- 第0日の実在責務に応じてnpm workspacesの`apps/web`、`apps/api`、`packages/contract`を作成。FEトークン、BE SQL、共有OpenAPI・生成型・契約試験を配置する。
- M-9/M-10は1件目で非表示、2件目で追加通知へ統一。本人の重複通報は数えない。
- BANと削除を分離。過去投稿は非公開とし、解除だけで再公開しない。本人/管理者の削除は別操作。
- FE/BE両方の契約承認者をiijimaとする。原資料は変更せず非公開のまま保持する。

## 代替案

FEもCloudflareへ統一する案はユーザーが選択しませんでした。独立リポジトリは初期の型・契約同期を増やすため、原計画のモノレポを使用します。BANで削除する案は不採用です。

## 影響

複数クラウドの権限・秘密・料金を管理します。第0日は設計/SQL/契約/検証に限定し、Next.js本体・Workerハンドラー・Cloud Run image・本番DBはまだ存在しません。契約生成とテストのCIは先に導入し、各実行対象の実装と同時に対応するproduction buildを追加します。

配信の公開方式は追加回答に基づく[ADR-0002](ADR-0002-authenticated-delivery.md)を適用します。元資料の矛盾を原文の改変で隠さず、決定として履歴に残します。
