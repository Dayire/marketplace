import type { Metadata } from "next";
import { Suspense } from "react";
import { fontClassName, fontVariables } from "@/lib/fonts";
import { MarketToolbar } from "@/features/trading/market-toolbar";
import { MarketplaceFooter } from "@/components/layout/marketplace-footer";
import { Header } from "@/components/layout/header";
import { MarketplaceLayout } from "@/components/layout/marketplace-layout";
import { MarketplaceProvider } from "@/components/providers/marketplace-provider";
import { getSiteUrl } from "@/lib/seo/site-url";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: getSiteUrl(),
  title: "Realms.market",
  description: "The Realms ecosystem marketplace",
  openGraph: {
    type: "website",
    siteName: "Realms.market",
    title: "Realms.market",
    description: "The Realms ecosystem marketplace",
  },
  twitter: {
    card: "summary_large_image",
    title: "Realms.market",
    description: "The Realms ecosystem marketplace",
  },
  icons: {
    icon: "/rw-logo.svg",
    shortcut: "/rw-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${fontClassName} antialiased`} style={fontVariables}>
        <MarketplaceProvider>
          <Suspense fallback={<div aria-hidden="true" className="h-[108px] border-b border-border bg-background" />}>
            <Header />
          </Suspense>
          <MarketplaceLayout>
            <MarketToolbar />
            {children}
          </MarketplaceLayout>
          <MarketplaceFooter />
        </MarketplaceProvider>
      </body>
    </html>
  );
}
