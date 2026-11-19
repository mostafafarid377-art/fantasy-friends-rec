import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  ShieldCheck,
  Timer,
  Users,
} from "lucide-react";
import { Badge, Slate } from "@/components/ui";

const STEPS = [
  {
    n: "01",
    title: "Build the league",
    body: "Name it, pick five-a-side or seven-a-side, share the eight-character code. The format locks every lineup rule for every manager from that moment on.",
  },
  {
    n: "02",
    title: "Draft fifteen, name seven",
    body: "Each manager takes 15 players from their league's own player database, then fields exactly 5 or 7 — one keeper, the rest outfield — plus a bench set by league settings.",
  },
  {
    n: "03",
    title: "Record the real matches",
    body: "The Match Organizer logs goals, assists, cards and subs minute by minute. Nothing scores until the League Leader approves the result.",
  },
  {
    n: "04",
    title: "The table settles it",
    body: "Approved results run through the points engine — position-based scoring, captain doubled — and the standings rebuild themselves. No arguments.",
  },
];

const FORMATS = [
  { name: "Five-a-side", starters: "5", gk: "1", outfield: "4", shapes: "1-2-1 · 1-1-2 · 1-3 · 2-2", bench: "League setting" },
  { name: "Seven-a-side", starters: "7", gk: "1", outfield: "6", shapes: "1-2-3 · 1-3-2 · 1-4-1 · 1-2-2-1", bench: "League setting" },
];

export default function LandingPage() {
  return (
    <main className="relative">
      {/* ---------------- hero ---------------- */}
      <section className="relative isolate overflow-hidden">
        <div className="absolute inset-0 -z-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/floodlit-pitch.jpg"
            alt=""
            className="h-full w-full object-cover object-center opacity-[0.55]"
          />
          <div className="absolute inset-0 bg-[linear-gradient(100deg,#070b09_18%,rgba(7,11,9,0.86)_46%,rgba(7,11,9,0.35)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-pitch-950 to-transparent" />
        </div>

        <div className="floodlight grain relative mx-auto max-w-6xl px-5 pb-24 pt-16 md:px-10 md:pb-32 md:pt-24">
          <div className="max-w-3xl">
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <Badge tone="live">
                <span className="h-1.5 w-1.5 rounded-full bg-green animate-pulse-dot" />
                Private leagues only
              </Badge>
              <Slate>5-a-side · 7-a-side · 15-player squads</Slate>
            </div>

            <h1 className="text-[clamp(3rem,11vw,7rem)] leading-[0.86] text-chalk">
              Settle it
              <br />
              <span className="text-green">on the table.</span>
            </h1>

            <p className="mt-7 max-w-xl text-[17px] leading-relaxed text-sage">
              Fantasy Friends runs your group's fantasy football properly: your own player
              database, real matches recorded minute by minute, results that need approval
              before they count, and a league table nobody can argue with.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/signup"
                className="inline-flex h-12 items-center gap-2 rounded-md bg-green px-6 font-display text-[16px] font-bold uppercase tracking-[0.06em] text-[#04120a] shadow-[0_10px_30px_-14px_rgba(49,224,125,0.9)] transition-all hover:bg-green-glow active:translate-y-px"
              >
                Create your league <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center rounded-md border border-line bg-pitch-900/70 px-6 font-display text-[16px] font-bold uppercase tracking-[0.06em] text-chalk backdrop-blur transition-colors hover:border-green hover:text-green"
              >
                Sign in
              </Link>
            </div>

            <dl className="mt-12 grid max-w-2xl grid-cols-2 gap-x-6 gap-y-6 border-t border-line pt-7 sm:grid-cols-4">
              {[
                ["Squad size", "15"],
                ["Starters 5v5", "5"],
                ["Starters 7v7", "7"],
                ["Scoring", "Configurable"],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="slate">{label}</dt>
                  <dd className="num mt-1.5 text-2xl font-semibold text-chalk">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ---------------- how it works: ruled list, not cards ---------------- */}
      <section className="mx-auto max-w-6xl px-5 py-20 md:px-10 md:py-28">
        <div className="mb-10 flex items-end justify-between gap-6 border-b border-line pb-5">
          <h2 className="text-[clamp(1.9rem,4vw,3rem)] text-chalk">How a season runs</h2>
          <Slate className="hidden sm:block">Four stages · one table</Slate>
        </div>

        <ol className="divide-y divide-line border-y border-line">
          {STEPS.map((s, i) => (
            <li
              key={s.n}
              className="group grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 py-7 transition-colors hover:bg-pitch-900/60 md:grid-cols-[6rem_18rem_1fr] md:gap-x-8"
              style={{ animation: `rise .5s cubic-bezier(.2,.8,.2,1) ${i * 60}ms both` }}
            >
              <span className="num text-[13px] font-semibold text-green/70 md:text-[15px]">{s.n}</span>
              <h3 className="col-span-1 self-start text-[26px] text-chalk md:text-[30px]">{s.title}</h3>
              <p className="col-span-2 max-w-2xl text-[15px] leading-relaxed text-sage md:col-span-1">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------- format table (the league table as hero) ------- */}
      <section className="border-y border-line bg-pitch-900">
        <div className="mx-auto max-w-6xl px-5 py-20 md:px-10 md:py-24">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] text-chalk">Two formats, one rulebook</h2>
            <Slate>Chosen once, enforced everywhere</Slate>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line bg-pitch-850">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  {["Format", "Starters", "Goalkeeper", "Outfield", "Formations", "Bench"].map((h) => (
                    <th key={h} className="slate px-4 py-3 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {FORMATS.map((f) => (
                  <tr key={f.name} className="transition-colors hover:bg-pitch-800">
                    <td className="px-4 py-4 font-display text-[19px] font-bold uppercase text-chalk">
                      {f.name}
                    </td>
                    <td className="num px-4 py-4 text-[17px] font-semibold text-green">{f.starters}</td>
                    <td className="num px-4 py-4 text-[15px] text-chalk">{f.gk}</td>
                    <td className="num px-4 py-4 text-[15px] text-chalk">{f.outfield}</td>
                    <td className="num px-4 py-4 text-[13px] text-sage">{f.shapes}</td>
                    <td className="px-4 py-4 text-[13px] text-sage">{f.bench}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 flex items-start gap-2 text-[13.5px] leading-relaxed text-sage-dim">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-dim" />
            Validation runs on the server too. A direct database request cannot put eleven
            players on a five-a-side pitch.
          </p>
        </div>
      </section>

      {/* ---------------- approval workflow ---------------- */}
      <section className="mx-auto max-w-6xl px-5 py-20 md:px-10 md:py-28">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <Slate className="mb-3">Result workflow</Slate>
            <h2 className="text-[clamp(1.9rem,4vw,3rem)] text-chalk">
              Nothing counts until it is approved
            </h2>
            <p className="mt-5 max-w-lg text-[15.5px] leading-relaxed text-sage">
              Organizers record what happened. The League Leader reviews it, approves or sends
              it back with a reason. Only approved matches reach the points engine, and every
              calculation is idempotent — recalculate as often as you like, the table never
              double-counts.
            </p>
            <ul className="mt-7 space-y-3">
              {[
                "Full match status history with who did what and when",
                "Rejected results return to the organizer with a reason",
                "Configurable scoring rules stay in draft until approved",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-[14.5px] text-chalk">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green" />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative overflow-hidden rounded-xl border border-line bg-pitch-850">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/tunnel.jpg" alt="" className="h-56 w-full object-cover opacity-45 md:h-72" />
            <div className="absolute inset-0 bg-gradient-to-t from-pitch-850 via-pitch-850/60 to-transparent" />
            <div className="relative -mt-24 space-y-px p-5">
              {[
                { label: "Draft", who: "Match Organizer", tone: "text-sage", icon: <Timer className="h-4 w-4" /> },
                { label: "Pending approval", who: "Submitted to League Leader", tone: "text-card-y", icon: <ClipboardCheck className="h-4 w-4" /> },
                { label: "Approved · points live", who: "Standings rebuilt", tone: "text-green", icon: <CheckCircle2 className="h-4 w-4" /> },
              ].map((s) => (
                <div
                  key={s.label}
                  className="flex items-center gap-3 rounded-lg border border-line bg-pitch-900/90 px-4 py-3 backdrop-blur"
                >
                  <span className={s.tone}>{s.icon}</span>
                  <span className="flex-1 font-display text-[17px] font-bold uppercase text-chalk">
                    {s.label}
                  </span>
                  <span className="slate hidden sm:block">{s.who}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- closing ---------------- */}
      <section className="border-t border-line bg-pitch-900">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-5 py-16 md:flex-row md:items-center md:justify-between md:px-10">
          <div>
            <h2 className="text-[clamp(1.7rem,3.4vw,2.4rem)] text-chalk">Bring the group in</h2>
            <p className="mt-2 flex items-center gap-2 text-[14.5px] text-sage">
              <Users className="h-4 w-4 text-green-dim" />
              One eight-character code. No public leagues, no strangers.
            </p>
          </div>
          <Link
            href="/signup"
            className="inline-flex h-12 items-center gap-2 rounded-md bg-green px-6 font-display text-[16px] font-bold uppercase tracking-[0.06em] text-[#04120a] transition-colors hover:bg-green-glow"
          >
            Start free <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <footer className="border-t border-line px-5 py-6 md:px-10">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 text-[12.5px] text-sage-dim sm:flex-row sm:justify-between">
            <span>Fantasy Friends — private fantasy football for groups.</span>
            <span className="num">5v5 · 7v7 · approved results only</span>
          </div>
        </footer>
      </section>
    </main>
  );
}
