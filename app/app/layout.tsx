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
  title: "MetrEx — parametric wildfire coverage",
  description: "Trade fully collateralized wildfire risk on Solana. Pays on fire proximity, not on damage.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={`${GeistSans.className} min-h-screen antialiased`}>
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">{children}</main>
          <footer className="mx-auto w-full max-w-6xl border-t border-line px-5 py-10 sm:px-8">
            <div className="flex flex-col gap-3 text-sm text-faint sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="font-medium text-dim">MetrEx</div>
                <p className="mt-1 max-w-md leading-relaxed">
                  Parametric gap coverage on Solana Devnet. mUSD is a test token with no value. Home labels are fictional;
                  coordinates are approximate points, not real addresses.
                </p>
              </div>
              <p className="max-w-xs leading-relaxed sm:text-right">Pays on fire proximity, not on damage.</p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
