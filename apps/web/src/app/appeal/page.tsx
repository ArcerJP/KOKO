import { validId } from "../../api/upload-contract";
import { operationsEntry, OperationsFrame } from "../manage/_components/entry";
import { AppealPanel } from "./appeal-panel";

export const dynamic = "force-dynamic";
export default async function AppealPage({
  searchParams,
}: {
  searchParams: Promise<{ post?: string | string[] }>;
}) {
  const entry = await operationsEntry();
  const { post } = await searchParams;
  const postId =
    typeof post === "string" && validId(post) ? post.toLowerCase() : "";
  return (
    <OperationsFrame title="異議申立て" enabled={entry !== null}>
      {entry ? (
        <AppealPanel
          key={`${entry.eventId}:${entry.owner}:${postId}`}
          eventId={entry.eventId}
          initialPostId={postId}
        />
      ) : null}
    </OperationsFrame>
  );
}
