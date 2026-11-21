import "@solana/wallet-adapter-react-ui/styles.css";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "MetrEx — wildfire risk exchange",
  description: "Trade fully collateralized YES and NO shares on historical wildfire proximity on Solana Devnet. Pays on fire proximity, not on damage.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={`${GeistSans.className} min-h-screen antialiased`}>
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
          <footer className="mx-auto w-full max-w-6xl border-t border-line px-4 py-6 sm:px-6">
            <div className="flex flex-col gap-1 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
              <p>MetrEx · Solana Devnet · mUSD is a test token · labels fictional</p>
              <p>Pays on fire proximity, not on damage.</p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
