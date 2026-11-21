import { cookies } from "next/headers";
import { googleAppOrigin, googleStartCookieName, googleStartTokenPattern } from "./google-oauth";

// A token minted by the proxy is forwarded to the page on the same request.
export async function readGoogleStartToken(): Promise<string | null> {
  const configured = googleAppOrigin();
  if (!configured) return null;
  const jar = await cookies();
  const token = jar.get(googleStartCookieName(true))?.value
    ?? (configured.startsWith("http:") ? jar.get(googleStartCookieName(false))?.value : undefined);
  return token && googleStartTokenPattern.test(token) ? token : null;
}
