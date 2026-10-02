import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../styles/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "KOKO | ログイン・撮影検証",
  description:
    "第49回技科大祭 KOKOのGoogleログイン導線と端末内メディア検証。撮影画面からの投稿は行いません。",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
