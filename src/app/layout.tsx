import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const barlow = localFont({
  variable: "--font-barlow-condensed",
  display: "swap",
  preload: false,
  src: [
    { path: "./fonts/barlow-condensed-latin-600-normal.woff2", weight: "600" },
    { path: "./fonts/barlow-condensed-latin-700-normal.woff2", weight: "700" },
    { path: "./fonts/barlow-condensed-latin-800-normal.woff2", weight: "800" },
  ],
});

const plex = localFont({
  variable: "--font-plex-sans",
  display: "swap",
  src: "./fonts/ibm-plex-sans-latin-wght-normal.woff2",
  weight: "100 700",
});

const plexMono = localFont({
  variable: "--font-plex-mono",
  display: "swap",
  preload: false,
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500" },
    { path: "./fonts/ibm-plex-mono-latin-600-normal.woff2", weight: "600" },
    { path: "./fonts/ibm-plex-mono-latin-700-normal.woff2", weight: "700" },
  ],
});

export const metadata: Metadata = {
  title: {
    default: "Fantasy Friends — private fantasy football for your group",
    template: "%s · Fantasy Friends",
  },
  description:
    "Create a private 5-a-side or 7-a-side fantasy league, build your squad, record real matches and settle the argument with a proper league table.",
  applicationName: "Fantasy Friends",
};

export const viewport: Viewport = {
  themeColor: "#070b09",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${plex.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh bg-pitch-950 text-chalk antialiased">{children}</body>
    </html>
  );
}
