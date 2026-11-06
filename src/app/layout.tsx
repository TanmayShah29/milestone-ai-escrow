import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const DESCRIPTION = "Pay freelancers and AI agents through PayPal when their work passes tests. AI writes the tests and attacks them before signing; only code moves the money.";
// ?v= changes with the image, so sites that cached the old preview fetch the new one.
const OG_IMAGE = { url: "/og.png?v=2", width: 1200, height: 630, alt: "Milestone: pay only when the work passes. A PayPal hold released by code when the signed tests pass." };
const OG_TITLE = "Milestone: pay only when the work passes";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "https://milestone-ai-escrow.onrender.com"),
  title: "Milestone",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Milestone", title: OG_TITLE, description: DESCRIPTION, url: "/", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: OG_TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-screen`}>
        <a href="#content" className="sr-only rounded-md bg-panel text-sm font-medium text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:px-3 focus:py-2">
          Skip to content
        </a>
        <header className="sticky top-0 z-50 border-b border-rule bg-paper/80 text-ink backdrop-blur-md supports-[backdrop-filter]:bg-paper/70">
          <nav className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 text-sm sm:gap-6" aria-label="Main">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink no-underline">
              <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
                <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.5 10.5l3 3 6-7" fill="none" stroke="var(--paid)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Milestone
            </Link>
            <Link href="/milestones" className="text-ink-2 no-underline transition-colors hover:text-ink">
              <span className="sm:hidden">Deals</span>
              <span className="hidden sm:inline">Your milestones</span>
            </Link>
            <Link href="/timeline" className="hidden text-ink-2 no-underline transition-colors hover:text-ink sm:inline">
              Timeline
            </Link>
            <Link href="/ledger" className="hidden text-ink-2 no-underline transition-colors hover:text-ink sm:inline">
              Ledger
            </Link>
            <Link href="/bounties" className="text-ink-2 no-underline transition-colors hover:text-ink">
              Bounties
            </Link>
            <Link href="/bench" className="hidden text-ink-2 no-underline transition-colors hover:text-ink sm:inline">
              Proof Bench
            </Link>
            <Link href="/new" className="ml-auto whitespace-nowrap rounded-md bg-accent px-3.5 py-1.5 font-medium text-accent-ink no-underline shadow-sm transition-opacity hover:opacity-90">
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
