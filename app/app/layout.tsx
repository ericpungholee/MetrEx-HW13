import "@solana/wallet-adapter-react-ui/styles.css";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "MetrEx — parametric wildfire underwriting exchange",
  description: "Underwrite individual parametric wildfire risk on Solana Devnet. Historical replay.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <Header />
          <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
          <footer className="mx-auto max-w-[1400px] px-4 pt-2 pb-10 text-[11px] text-faint">
            MetrEx · Solana Devnet · mUSD is a test token with no value · Labels are fictional and coordinates are
            approximate points, not real addresses · Pays on fire proximity, not on damage.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
