import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Sukhna Foods Operations Dashboard",
  description: "Scan → email → auto-extract → validate → upload. Invoice operations console for Sukhna Foods.",
  manifest: "/manifest.webmanifest",
  applicationName: "Sukhna Sales Order",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Sales Order" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#111113",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
