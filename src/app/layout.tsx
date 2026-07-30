import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sukhna Foods Operations Dashboard",
  description: "Scan → email → auto-extract → validate → upload. Invoice operations console for Sukhna Foods.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
