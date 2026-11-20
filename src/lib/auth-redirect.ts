const redirectBase = "https://fantasy-friends.invalid";

/** Accept only an app path, never a URL or a browser-normalized network path. */
export function safeAuthPath(value: string | null | undefined): string {
  if (!value || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || /[\\\s\p{Cc}]/u.test(value)) {
    return "/dashboard";
  }
  const url = new URL(value, redirectBase);
  if (url.origin !== redirectBase || url.pathname.startsWith("//") || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return "/dashboard";
  return url.pathname + url.search + url.hash;
}
