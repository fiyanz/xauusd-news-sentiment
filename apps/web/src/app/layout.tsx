import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XAU/USD INTELLIGENCE — Institutional Terminal",
  description: "Sistem Informasi Pasar Emas Otomatis & Analisis Dampak Rilis Berita Ekonomi",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="bg-tv-dark text-tv-text antialiased h-screen flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
