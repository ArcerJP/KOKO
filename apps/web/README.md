# KOKO フロントエンド

Next.js App Router・TypeScriptをVercelで実行する領域です。[初期トークン](src/styles/tokens.css)を使う、端末内の撮影・トリム検証画面を実装しています。Googleログイン・アップロード・AI判定は未接続です。Figmaデザインの確定とも区別します。

[起動方法・実機の確認手順](../../docs/product/stage-one-capture.md)、[クラウドの準備](../../docs/product/cloud-setup.md)、[自動検証](../../docs/ci.md)を参照してください。リポジトリルートで`npm.cmd ci`、`npm.cmd run dev`を実行すると起動します。

## 初期トークン（K-07、初版承認済み）

- 明るい背景、白いsurface、インディゴの主色。危険・注意・成功は色に加えて文字/状態表示で区別。
- 日本語を含むsystem font、本文1rem、行間1.6。見出しは1.5rem/2rem。
- 余白は0.25rem単位、カード角丸1rem、操作領域は最小2.75rem。
- キーボードfocusを表示し、`prefers-reduced-motion`でfeedback時間を0へ。

正確な値はCSSだけを正本とし、変更はCSSと試験へ反映します。主要な文字色は4.5:1以上の計算テスト対象ですが、画面全体のアクセシビリティや実機可読性の完了を意味しません。

第6要件以降のiOS/Androidは[対応準備](../../docs/architecture/native-readiness.md)に従います。現段階でCSSを二重管理せず、native方式選定時に中立トークンと生成先を決めます。

## 実装時の入口

API型は`@koko/contract/api`、純粋な契約は`@koko/contract`から使用します。手書き型を複製しません。`src/api`のGET境界と`src/mocks`のMSWをNodeテストで検証します。ブラウザ本番でMSWや偽セッションを有効化する設定はありません。実認証の試験は後続です。

撮影UIは`src/components`、トリムは`src/media`、単体・HTTP/メディア統合は`test`、実ブラウザ操作は`e2e`です。動的メディア処理はWorkerへ分離し、必要時だけ読み込みます。

メディアは[認証ゲート](../../docs/decisions/ADR-0002-authenticated-delivery.md)経由。Cookieを通さない公開画像最適化cacheや、署名付きStream URLの直接配布で代替しません。詳細な順序は[FEタスク](../../docs/product/development-plan.md#feタスク)を参照してください。
