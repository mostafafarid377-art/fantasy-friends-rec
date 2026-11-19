import { handler } from "@/lib/server";
import { getSessionSnapshot } from "@/lib/session";

export const dynamic = "force-dynamic";
export const GET = handler(async () => Response.json(await getSessionSnapshot(), {
  headers: { "Cache-Control": "private, no-store" },
}));
