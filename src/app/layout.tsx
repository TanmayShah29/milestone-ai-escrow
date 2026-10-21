import type { Metadata } from "next";
import { Geist_Mono, Public_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const publicSans = Public_Sans({ variable: "--font-public-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Milestone",
  description: "Pay-on-proof escrow on PayPal: money is held until the work is proven. The AI checks; fixed rules decide.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${publicSans.variable} ${geistMono.variable} min-h-screen`}>
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
            <Link href="/new" className="ml-auto whitespace-nowrap rounded-md bg-[#e4ecea] px-3 py-1.5 font-medium text-[#13233a] no-underline hover:bg-white">
              New<span className="hidden sm:inline"> milestone</span>
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
