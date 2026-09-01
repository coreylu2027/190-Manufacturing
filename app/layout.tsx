import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

import { Providers } from "@/app/providers";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "FRC 190 Manufacturing OS",
  description: "Live manufacturing operations and shop-floor workflow for FRC Team 190.",
  openGraph: {
    title: "FRC 190 Manufacturing OS",
    description: "Claim operations, run the right machine, and keep the shop floor in sync.",
    type: "website",
    images: [{ url: "/og.png", width: 1732, height: 909, alt: "FRC 190 Manufacturing OS" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "FRC 190 Manufacturing OS",
    description: "Claim operations, run the right machine, and keep the shop floor in sync.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
