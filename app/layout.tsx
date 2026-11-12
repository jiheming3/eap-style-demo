import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "陪伴空间 · EAP 对话体验", description: "亲切、沉稳、专业的 EAP AI 回答风格体验。" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
