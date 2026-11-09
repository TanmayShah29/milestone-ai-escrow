import type { Metadata } from "next";

export const metadata: Metadata = { title: "Spending mandate" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
