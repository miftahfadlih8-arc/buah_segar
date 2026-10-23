import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sistem Operasi Distribusi Buah Segar — Bekasi",
  description:
    "Platform operasional pengadaan, QC, grading, inventori FEFO, penjualan grosir/HORECA, pengiriman, dan akuntansi distribusi buah segar Bekasi.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
