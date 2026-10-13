import type { Metadata, Viewport } from "next";
import { Playfair_Display, Space_Grotesk } from "next/font/google";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";

const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const serif = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["italic", "normal"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Prahari — Tourist Safety",
  description: "Digital tourist ID, location-aware safety alerts and emergency SOS for travellers in India.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#fbfbf8",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
