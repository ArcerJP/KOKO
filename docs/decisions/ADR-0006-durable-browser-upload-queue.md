# ADR-0006: 本人別の端末内送信キューと明示再開

- 状態：Accepted（ローカル実装の設計。実環境の有効化・端末受入は別）
- 日付：2026-10-05
- 判断：継続方針による技術判断。実データ保存・権限変更・配備の承認ではない。

## 背景

F1-5/F2-1は、送信前の端末内保存、画面遷移中の継続、OS中断からの復帰を要求します。通信切断は未保存の証拠ではなく、新規IDによる再送は投稿の重複を招きます。ブラウザ保存には機微な画像・動画が含まれ得ます。

## 決定

IndexedDBへBlobと本人/event・固定client_request_id・再開metadataを一つのtransactionで保存し、transaction完了後だけ端末受付を表示します。Blobとmetadataを別storeに分け、パート進捗の更新で大きなBlobを再保存しません。root layoutのClient providerがキュー実行を所有し、撮影labは非送信を維持、新しい`/upload`で明示操作します。

同一originのWeb Locksで初回本人確認（共有Cookie更新を含む）と送信実行を排他し、利用できなければ安全停止します。復帰は本人を再確認して明示再開。同じ本人/event/規約版とfresh CSRFを各制御操作で照合し、ログアウト開始・Auth変更・pagehideで中断とメモリ破棄。認可の正本は引き続きWorkerです。

singleの不明結果は同じuploadのcompleteで照合し、未完了と確認できた場合だけ条件付きPUT。multipartは確認済みパートETagとkey/provider識別子のdigestを保存し、未確認パートから再開します。完了manifestを先に永続化し、以後は同じcompleteのみ再実行します。初回に加え自動再試行は最大3回、明示再開は同じIDで新しい試行周期を開始します。

## 比較と影響

| 案                                  | 利点                                               | 欠点・判断                                                        |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| IndexedDB＋root provider＋Web Locks | Blobをtransaction保存、画面非依存、既存APIを再利用 | quota/evictionと対応端末の制約。採用                              |
| React画面内のメモリだけ             | 実装が小さい                                       | 遷移・終了で消失。要件を満たさない                                |
| Service Workerによる常時送信        | 対応環境では背景処理の余地                         | OS終了中の保証にはならず、認証/ライフサイクルが増える。今回不採用 |
| localStorageと短時間lease           | 同期APIで手軽                                      | 大きなBlobに不適合、停止タブと期限による二重実行。代用しない      |

新しいクラウド資源・実行依存は不要。ブラウザ試験のbundleに、既存lockfileと同版のesbuildをWebの直接dev依存として明示します。実Authを回避するテスト用routeは製品へ追加しません。

## プライバシー・制約

IndexedDBは暗号化された個人保管庫ではありません。同一originスクリプト/XSS・同じブラウザプロフィールや端末へのアクセスから原本を保護する保証はありません。秘密/JWT/CSRF/署名URL/ファイル名は保存せず、成功後に端末Blobを除去し、未完了分には明示削除を用意します。ログアウトだけでは端末保存分を消しません。端末内削除は、既送信投稿のサーバー削除ではありません。

3秒は受付目標であり、遅延時に保存前の成功を表示しません。ブラウザの容量不足・データ消去・eviction・OS中断・物理故障を排除できません。停止後も既に送信した要求や短命PUT権限を取り消せるとは保証しません。実機の計測と実R2/認証/CORS受入を別途行います。

詳細の正本は[Webの送信キュー](../../apps/web/README.md#端末内送信キューと投稿画面f1-5f2-1既定無効)。トップレベル領域、AGENTS、Skillの追加は不要です。

## 一次資料（2026-10-05確認）

- [IndexedDB仕様](https://www.w3.org/TR/IndexedDB/)：transaction・structured clone・durability hint。
- [Web Locks仕様](https://www.w3.org/TR/web-locks/)：同originの排他と寿命。
- [Next.js layout](https://nextjs.org/docs/app/getting-started/layouts-and-pages)：画面遷移時のlayoutと状態維持。
- [ブラウザの保存上限と消去](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)：保存失敗と保持の制約。
