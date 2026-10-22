import type { Metadata } from "next";
import { Geist_Mono, Public_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const publicSans = Public_Sans({ variable: "--font-public-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const DESCRIPTION = "Pay-on-proof escrow on PayPal: money is held until the work is proven. The AI checks; fixed rules decide.";
const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Milestone: money moves only on proof. A PayPal hold released by fixed rules when the signed tests pass." };

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "https://milestone-ai-escrow.onrender.com"),
  title: "Milestone",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Milestone", title: "Milestone: money moves only on proof", description: DESCRIPTION, url: "/", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "Milestone: money moves only on proof", description: DESCRIPTION, images: [OG_IMAGE] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${publicSans.variable} ${geistMono.variable} min-h-screen`}>
        <a href="#content" className="sr-only rounded-md bg-panel text-sm font-medium text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:px-3 focus:py-2">
          Skip to content
        </a>
        <header className="bg-[#13233a] text-[#e4ecea]">
          <nav className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 text-sm sm:gap-6" aria-label="Main">
            <Link href="/" className="font-semibold tracking-tight no-underline">
              Milestone
            </Link>
            <Link href="/milestones" className="text-[#b9c7cf] no-underline hover:text-white">
              <span className="sm:hidden">Yours</span>
              <span className="hidden sm:inline">Your milestones</span>
            </Link>
            <Link href="/timeline" className="text-[#b9c7cf] no-underline hover:text-white">
              Timeline
            </Link>
            <Link href="/ledger" className="text-[#b9c7cf] no-underline hover:text-white">
              Ledger
            </Link>
            <Link href="/new" className="ml-auto whitespace-nowrap rounded-md bg-[#e4ecea] px-3 py-1.5 font-medium text-[#13233a] no-underline hover:bg-white">
              New<span className="hidden sm:inline"> milestone</span>
            </Link>
          </nav>
        </header>
        <div id="content" tabIndex={-1} className="outline-none">
          {children}
        </div>
      </body>
    </html>
  );
}
