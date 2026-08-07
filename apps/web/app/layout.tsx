import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./generated-globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Mindmark — 可验证 AI 学习 Agent",
  description: "上传资料，由多个 AI Agent 生成可验证知识卡，并通过 FSRS 安排长期复习。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
