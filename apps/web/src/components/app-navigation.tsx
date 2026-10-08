import Link from "next/link";
/** Navigation does not bypass the destination page's independent feature/auth gates. */
export function AppNavigation() {
  return (
    <nav aria-label="アプリの画面">
      <p style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1rem" }}>
        <Link href="/feed" prefetch={false}>
          みんなの投稿
        </Link>
        <Link href="/upload" prefetch={false}>
          撮影・送信
        </Link>
        <Link href="/themes" prefetch={false}>
          お題
        </Link>
        <Link href="/account/posts" prefetch={false}>
          自分の投稿
        </Link>
        <Link href="/account" prefetch={false}>
          アカウント
        </Link>
        <Link href="/help" prefetch={false}>
          ヘルプ
        </Link>
      </p>
    </nav>
  );
}
