import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "她们会怎么想？",
  description: "与古今女性先行者进行一场温柔而清醒的 AI 圆桌，整理困惑并生成行动卡。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
