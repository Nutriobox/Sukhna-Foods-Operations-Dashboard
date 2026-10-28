import "./globals.css";
import type { Metadata, Viewport } from "next";
import Script from "next/script";

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
      <head>
        {/* Fonts for the redesigned landing page (2026-10-28): Inter for
            body, Plus Jakarta Sans for display headings on the home tiles. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap"
        />
      </head>
      <body>
        {children}
        {/*
          Real-time sync notifier — subscribes to Supabase Realtime on
          costing_snapshots + inventory_snapshots so the dashboard refreshes
          within half a second when any PACT sync completes anywhere.
          React components listen via:
            window.addEventListener('ops-sync-update', (e) => { ... });
        */}
        <Script
          src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"
          strategy="afterInteractive"
        />
        <Script src="/js/sync-refresh.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
