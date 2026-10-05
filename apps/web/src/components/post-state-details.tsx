import type { OwnPost } from "../api/own-posts-contract";

const categories: Record<NonNullable<OwnPost["block_category"]>, string> = {
  sexual: "性的な内容",
  violence: "暴力的な内容",
  hate: "差別・憎悪に関する内容",
  harassment: "嫌がらせ・脅迫に関する内容",
  self_harm: "自傷行為に関する内容",
  illicit: "違法行為に関する内容",
  other: "その他の安全基準",
};
const deletionLabels: Record<
  NonNullable<OwnPost["deletion"]>["state"],
  string
> = {
  RETENTION_UNKNOWN: "保持期限が未確認のため、物理削除を保留しています。",
  RETENTION_PENDING: "記録された保持期限まで、物理削除を保留しています。",
  PHYSICAL_DELETION_NOT_ENABLED:
    "物理削除の実行機能は未有効化です。削除完了ではありません。",
  DELETION_UNCONFIRMED: "保存先の実物が削除されたかは未確認です。",
};
/** Shared owner/operator wording; no raw category, provider key or completion inference. */
export function PostStateDetails({ post }: { post: OwnPost }) {
  return (
    <>
      {post.status === "blocked" && post.block_category ? (
        <p className="warning">
          公開不可の理由：{categories[post.block_category]}
          。自動判定による大分類です。異議申立てで確認を依頼できます。
        </p>
      ) : null}
      {post.status === "deleted" && post.deletion ? (
        <div>
          <p>{deletionLabels[post.deletion.state]}</p>
          {post.deletion.retention_until ? (
            <p>
              DBに記録された保持期限：
              <time dateTime={post.deletion.retention_until}>
                {new Date(post.deletion.retention_until).toLocaleString(
                  "ja-JP",
                  { timeZone: "Asia/Tokyo" },
                )}
              </time>
              （日本時間）
            </p>
          ) : (
            <p>DBに記録された保持期限：未確認</p>
          )}
          <p>
            保存先の実際のロック状態・物理削除完了は、この記録だけでは確認できません。
          </p>
        </div>
      ) : null}
    </>
  );
}
