import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Deal room · Milestone" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
