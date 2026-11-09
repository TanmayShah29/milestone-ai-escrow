import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Resolution desk · Milestone" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
