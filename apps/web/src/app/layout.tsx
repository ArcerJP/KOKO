import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { UploadProvider } from "../components/upload-provider";
import { uploadConfiguration } from "../api/upload-config";
import "../styles/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "第49回技科大祭 | 写真・動画共有",
  description:
    "第49回技科大祭の写真・動画共有アプリ。ログインして投稿やお題を確認できます。",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  const upload = uploadConfiguration(process.env);
  return (
    <html lang="ja">
      <body>
        {upload ? (
          <UploadProvider key={JSON.stringify(upload)} config={upload}>
            {children}
          </UploadProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
