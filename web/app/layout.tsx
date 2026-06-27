import type { Metadata } from "next";
import { Space_Grotesk, Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const sg = Space_Grotesk({ subsets: ["latin"], variable: "--sg", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--inter", display: "swap" });
const plex = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Atlas — autonomous treasury agent on Casper",
  description:
    "An agent that buys risk data over x402 before it moves a single CSPR, and records every decision on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sg.variable} ${inter.variable} ${plex.variable}`}>
      <body>{children}</body>
    </html>
  );
}
