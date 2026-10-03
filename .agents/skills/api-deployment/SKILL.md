---
name: api-deployment
description: KOKOのCloudflare API配備の準備・実行・失敗調査・復旧、WorkerのSupabase Secretや配備用トークンの変更・期限更新、会話中断後の配備再開で使用します。現物確認、読取り診断、限定変更、配備後受入を分離します。
---

# API配備と復旧

会話だけを手掛かりに設定を作り直さず、稼働中Workerを保護しながら現在地を復元する。[TOOLS.md](../../../TOOLS.md#web操作の利用条件)の条件を満たす既存読取り診断は継続承認済み。実配備や秘密・権限等の変更は別の[保護操作](../../../AGENTS.md#保護操作の確認)であり、本人の包括的な「勝手に進めて」でも実行しない。

## 読み込み先

- 現在の適用済み状態・障害原因・承認済み権限：[クラウド準備](../../../docs/product/cloud-setup.md#2026-10-03の配備障害と再発防止)。日付付き記録を現物で更新する。
- 配備・診断の実装と限界：[CI規約](../../../docs/ci.md#開発用api配備)。必要なworkflow・scriptをそこから読む。
- 権限の採用理由：[ADR-0003](../../../docs/decisions/ADR-0003-worker-scoped-deployment.md)。最新の公式仕様は同文書の参照先で確認する。
- タスク内の承認・実行証拠：対象の`work/notebook/<task-id>/`。公開文書へ秘密や非公開ログを転記しない。

コード・複数ファイルを変える場合は`research-plan-implement`、Git操作は`git-workflow`を併用する。一般の調査・Git規則をこのSkillへ複製しない。

## 1. 再開時の現物確認

1. 対象repo・Worker・Environment・承認範囲を特定する。Cloudflare配備用token、Supabase CLI管理用token、Worker用Supabaseキーは用途が別であり、交換・失効を連動させない。
2. 現在のmain SHA、対象PRのmerge、固定されたWrangler版、作業ツリー差分を確認する。過去の会話、ローカルbuild、PRのCI成功だけから外部適用済みと判断しない。
3. `KOKO_API_AUTO_DEPLOY_ENABLED`の保存値、同名Environment variableの有無、Environmentのmain限定、実行中・待機中の配備、旧Builds未接続を読み取る。`false`は手動`API Deploy`を禁止しない。停止が必要なら対象を示して承認を取り、保存後に再照会する。
4. Active Deploymentの完全Version ID・配信率・更新元、R2 binding、Accessの全URL保護、WorkerのSecret名と適用環境、tokenの保存済みpolicy・期限を確認する。秘密値や認証Cookieは取得・表示しない。変更前の復旧対象を非公開の作業記録へ残す。
5. 文書と現物が違う場合は、確認日時・根拠・未解決点を分けて記録する。ログイン、秘密入力、重要な権限判断が必要な時点で本人へまとめて依頼する。

## 2. 変更前後の読取り診断

DashboardからのSecret・binding等の保存は配備元の状態を変え、次のWrangler配備で追加のmetadata読取りが必要になる場合がある。過去に同じtokenで配備できたことを十分条件にしない。

1. Dashboard保存後、配備tokenの変更・更新後、metadataエラー後は、実配備より前に既存の`API Deploy Diagnostics`を使用する。依頼目的、固定repo/Worker、レビュー済みmain SHAと診断内容、既存Environment Secret/権限、配備停止・競合runなしを確認し、起動を通知して1回実行する。これらが満たされれば毎回許可を聞き直さない。任意URL・新たな秘密表示・権限追加・配備/書込みを含めず、条件不明や実行結果不明では起動/重複dispatchをせず読取りで調べる。
2. `deployment_source`と7GETのラベル・HTTP status・固定エラーコード・run URLを照合する。`ALL_METADATA_READS_OK`でもupload・設定差分・Supabase接続は未検証。状態やmain・資格情報が変わった後に古い成功結果を流用しない。
3. 401/403なら失敗APIと現在の公式権限仕様を照合する。通信失敗や5xxを権限不足と断定しない。一般的なmetadataエラーだけでWrangler更新、Supabaseキーの再入力、広い管理権限追加を提案しない。
4. 最小変更案には、読取範囲・書込範囲・期限・費用・取消条件を示す。別Workerも含むMetadata Read-Onlyは無害ではないため、権限追加は本人判断とする。Admin、R2/D1等の未使用権限、Global API Keyで回避しない。
5. 承認された変更だけを保存し、policy・期限・IP条件を再確認。同じ診断で前後比較し、改善しなければ承認済みの取消条件に従う。別roleの追加や反復配備へ自動で進まない。

診断は現在、手動実行の運用ゲートであり、配備workflowに自動接続されたゲートではない。診断結果や原因が未確定のまま「修復完了」と報告しない。

## 3. Secretと期限の取扱い

- キー入力は本人。値の再表示・チャットへの貼付・Gitやログへの保存を求めず、登録名・環境・用途だけを確認する。metadata権限エラーをSupabaseのキー不良と混同しない。
- 期限編集前に、保存済み表示と既存のUTC/JST確認記録を読む。保存予定payload、保存後のUI、実保存値の確認を区別し、表示の日付差だけで延長・短縮を繰り返さない。
- 本人の希望日・タイムゾーンと、確認可能ならUTCの`expires_on`を対応させる。保存前に期限以外のpolicy・IP条件が変わらないことを確認し、承認された保存後は開き直して照合する。実保存時刻を確認できなければ、推定を確定扱いにせず確認範囲を明示する。
- 期限・権限が確定したtokenを作り直すことや、既存Secretの入れ替えを、確認だけのつもりで行わない。

## 4. 実配備と受入

1. 診断成功後も、対象main SHA・Worker・変更内容・保護・復旧対象・実行回数を示し、今回の実配備について直前の個別確認を得る。通常PRのmergeや診断成功は配備承認ではない。障害復旧中は自動配備OFFを維持する。
2. `API Deploy`のmainを1回だけ実行する。固定Wranglerと`--strict`、既存ガードを維持し、ローカルCLIや別資格情報で迂回しない。起動結果が不明ならrunを照会してから判断し、重複dispatchしない。
3. 失敗・タイムアウトはActive Deploymentを再確認してから次を決める。設定差分で止まれば差分と意図を確認し、`--strict`解除・強制上書き・自動再試行をしない。
4. 成功jobのSHA・Versionを実際のActive Deploymentと照合し、[受入条件](../../../docs/product/cloud-setup.md#初回と自動化後の受入)に従って固定URL・Version URLの未認証保護、認証後health、binding、Secret名、旧Builds未接続を確認する。ログインが必要なら本人へ渡す。DB書込み・正式イベント作成は配備受入へ混ぜない。
5. 実施・未実施・残る本人操作をクラウド準備とタスク記録へ反映する。自動配備再開は別判断であり、診断成功だけで`true`へ戻さない。

## 再開できる記録

中断・引継ぎ時には、確認日時、main SHA、診断/配備runと結果、Active Version、auto deployの保存値、承認済み変更、未実施の操作、次の人間判断を残す。会話履歴が見えないこと自体をクラウド障害の原因と断定せず、記録と現物を照合する。既知の障害を防ぐ手順であり、将来の仕様変更や未知の故障が起こらない保証ではない。
