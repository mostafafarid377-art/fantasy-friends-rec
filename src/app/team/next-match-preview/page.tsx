import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LineupPreview } from "@/components/lineup-preview/LineupPreview";

export const metadata: Metadata = {
  title: "Next Match Lineup Preview",
  robots: { index: false, follow: false },
};

export default async function NextMatchPreviewPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  if (process.env.NODE_ENV !== "development" || process.env.LINEUP_DESIGN_PREVIEW !== "1") notFound();
  return <LineupPreview fromMySquad={(await searchParams).from === "squad"} />;
}
