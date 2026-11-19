"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ClipboardList,
  Cog,
  History,
  LayoutDashboard,
  LogOut,
  Swords,
  Table2,
  User,
  Users,
  UserSquare2,
  Wallet,
  Zap,
} from "lucide-react";
import { useLeague } from "./LeagueContext";
import { Wordmark } from "./Mark";
import { Avatar, Badge, LiveDot } from "./ui";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  group: "play" | "league" | "you";
  badge?: boolean;
};

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/team", label: "My Team", icon: <Zap className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/standings", label: "Standings", icon: <Table2 className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/fixtures", label: "Fixtures", icon: <ClipboardList className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/matches", label: "Match Centre", icon: <Swords className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/points", label: "Points", icon: <Wallet className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/history", label: "History", icon: <History className="h-[18px] w-[18px]" />, group: "play" },
  { href: "/members", label: "Members", icon: <Users className="h-[18px] w-[18px]" />, group: "league" },
  { href: "/players", label: "Players", icon: <UserSquare2 className="h-[18px] w-[18px]" />, group: "league" },
  { href: "/rules", label: "Scoring", icon: <Cog className="h-[18px] w-[18px]" />, group: "league" },
  { href: "/notifications", label: "Notifications", icon: <Bell className="h-[18px] w-[18px]" />, group: "you", badge: true },
  { href: "/profile", label: "Profile", icon: <User className="h-[18px] w-[18px]" />, group: "you" },
  { href: "/settings", label: "Settings", icon: <Cog className="h-[18px] w-[18px]" />, group: "you" },
];

const MOBILE: NavItem[] = [
  NAV[0],
  NAV[1],
  NAV[4],
  NAV[2],
  { href: "/notifications", label: "Alerts", icon: <Bell className="h-[19px] w-[19px]" />, group: "you", badge: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { league, leagues, selectLeague, user, unread, logout, refresh, recovered } = useLeague();
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-dvh bg-pitch-950">
      {recovered > 0 && (
        <div className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-2 bg-green-deep/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-green-glow">
          {recovered} pending change{recovered > 1 ? "s" : ""} recovered
        </div>
      )}

      {/* ---------------- desktop rail ---------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-line bg-pitch-900 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/dashboard">
            <Wordmark />
          </Link>
        </div>

        {/* league switcher */}
        <div className="relative px-3 pb-3">
          <button
            onClick={() => setSwitcher((s) => !s)}
            className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-pitch-850 px-3 py-2.5 text-left transition-colors hover:border-green-dim"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-green/12 font-display text-[13px] font-bold text-green">
              {league ? league.format.replace("v", "-") : "—"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="slate block leading-none">Active league</span>
              <span className="mt-1 block truncate text-[13.5px] font-semibold text-chalk">
                {league?.name ?? "No league"}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-sage transition-transform ${switcher ? "rotate-180" : ""}`} />
          </button>

          {switcher && (
            <>
              <button className="fixed inset-0 z-10 cursor-default" aria-label="Close" onClick={() => setSwitcher(false)} />
              <div className="absolute left-3 right-3 z-20 mt-1.5 overflow-hidden rounded-lg border border-line bg-pitch-850 shadow-2xl">
                {leagues.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => {
                      selectLeague(l.id);
                      setSwitcher(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13.5px] transition-colors hover:bg-pitch-800 ${
                      l.id === league?.id ? "text-green" : "text-chalk"
                    }`}
                  >
                    <span className="truncate">{l.name}</span>
                    <span className="slate shrink-0">{l.format}</span>
                  </button>
                ))}
                <Link
                  href="/leagues"
                  onClick={() => setSwitcher(false)}
                  className="block border-t border-line px-3 py-2.5 text-[13px] text-sage hover:text-green"
                >
                  + Create or join a league
                </Link>
              </div>
            </>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {(["play", "league", "you"] as const).map((group) => (
            <div key={group} className="mb-4">
              <div className="slate px-3 pb-2">{group === "play" ? "Matchday" : group === "league" ? "League" : "You"}</div>
              <ul className="space-y-0.5">
                {NAV.filter((n) => n.group === group).map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`group flex items-center gap-3 rounded-md px-3 py-2 text-[14px] transition-all ${
                        isActive(item.href)
                          ? "bg-green/10 text-green"
                          : "text-sage hover:bg-pitch-850 hover:text-chalk"
                      }`}
                    >
                      <span className={isActive(item.href) ? "text-green" : "text-sage-dim group-hover:text-sage"}>
                        {item.icon}
                      </span>
                      <span className="flex-1">{item.label}</span>
                      {item.badge && unread > 0 && (
                        <span className="num rounded bg-green px-1.5 py-px text-[10px] font-bold text-[#04120a]">
                          {unread}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <Link
            href="/profile"
            className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-pitch-850"
          >
            <Avatar name={user?.displayName ?? "?"} url={user?.avatarUrl} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold text-chalk">
                {user?.displayName}
              </span>
              <span className="block truncate text-[11.5px] text-sage-dim">@{user?.username}</span>
            </span>
          </Link>
          <button
            onClick={() => void logout()}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-[13.5px] text-sage transition-colors hover:bg-pitch-850 hover:text-card-r"
          >
            <LogOut className="h-[18px] w-[18px]" />
            Sign out
          </button>
        </div>
      </aside>

      {/* ---------------- mobile top bar ---------------- */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-pitch-950/92 px-4 backdrop-blur lg:hidden">
        <Link href="/dashboard">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-3">
          {league && <Badge tone="live">{league.format}</Badge>}
          <Link href="/profile" aria-label="Profile">
            <Avatar name={user?.displayName ?? "?"} url={user?.avatarUrl} size={30} />
          </Link>
        </div>
      </header>

      {/* ---------------- content ---------------- */}
      <main className="pb-24 lg:pb-10 lg:pl-[236px]">{children}</main>

      {/* ---------------- mobile tab bar ---------------- */}
      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-pitch-900/97 backdrop-blur lg:hidden">
        <ul className="mx-auto flex max-w-lg items-stretch justify-around">
          {MOBILE.map((item) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={`relative flex h-16 flex-col items-center justify-center gap-1 transition-colors ${
                  isActive(item.href) ? "text-green" : "text-sage-dim"
                }`}
              >
                {item.icon}
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em]">{item.label}</span>
                {item.badge && unread > 0 && (
                  <span className="num absolute right-[22%] top-2.5 rounded bg-green px-1 text-[9px] font-bold text-[#04120a]">
                    {unread}
                  </span>
                )}
                {isActive(item.href) && <span className="absolute inset-x-5 top-0 h-0.5 bg-green" />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2">
            <LiveDot />
            <span className="slate">{eyebrow}</span>
          </div>
        )}
        <h1 className="text-[clamp(2rem,5vw,3.1rem)] text-chalk">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-sage">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}
