import { SquadScreen } from "@/components/SquadScreen";

export default function TeamPage() {
  const showLineupPreview = process.env.NODE_ENV === "development" && process.env.LINEUP_DESIGN_PREVIEW === "1";
  return <SquadScreen showLineupPreview={showLineupPreview} enableNextMatch={!showLineupPreview} />;
}
