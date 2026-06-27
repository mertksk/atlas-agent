import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Editorial high-contrast serif for display — gives the treasury a "printed
// annual report" gravitas you don't get from a grotesk.
const display = Fraunces({
  subsets: ["latin"],
  variable: "--fr",
  display: "swap",
  style: ["normal", "italic"],
  axes: ["SOFT", "WONK", "opsz"],
});
// Warm, slightly humanist grotesk for running text — not Inter.
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--hk", display: "swap" });
// Technical mono for ledger figures, hashes, agent labels.
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--jb", display: "swap" });

export const metadata: Metadata = {
  title: "Atlas — autonomous treasury agent on Casper",
  description:
    "An agent that buys risk data over x402 before it moves a single CSPR, and records every decision on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
