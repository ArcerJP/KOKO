import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // 写真は端末内Blobをそのまま表示。認証メディアも公開変換cacheに渡さない。
  images: { unoptimized: true },
};

export default config;
