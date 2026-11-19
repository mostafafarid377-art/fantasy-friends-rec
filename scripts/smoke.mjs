/**
 * End-to-end smoke test against a running Fantasy Friends server.
 *   BASE=https://host:port node scripts/smoke.mjs
 * Exits non-zero if any workflow check fails.
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let cookie = "";

async function call(path, { method = "GET", body, opId } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie,
      "x-operation-id": opId || crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0];
    if (pair.startsWith("ff_session=")) cookie = pair;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, ok: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

const stamp = Date.now();
const email = `gaffer${stamp}@example.com`;

const signup = await call("/api/auth/signup", {
  method: "POST",
  body: {
    email,
    username: `gaffer${stamp}`.slice(0, 24),
    displayName: "The Gaffer",
    password: "password123",
  },
});
check("signup creates a session", signup.status === 201 && signup.data?.user?.username, `status=${signup.status}`);

const session = await call("/api/auth/session");
check("session restores the user", session.data?.user?.email === email);

const league = await call("/api/leagues", {
  method: "POST",
  body: { name: "Tuesday Night League", format: "5v5", subsCount: 5, teamName: "The Gaffers" },
});
const leagueId = league.data?.league?.id;
check("5v5 league created", league.status === 201 && leagueId, `status=${league.status}`);
check("format stored with 5 starters", league.data?.league?.starters === 5, JSON.stringify(league.data?.league ?? league.data));

const rules = await call(`/api/leagues/${leagueId}/rules`);
check("scoring rules seeded as draft", (rules.data?.rules?.length ?? 0) > 0 && rules.data?.approved === false, `count=${rules.data?.rules?.length}`);

const teamA = await call(`/api/leagues/${leagueId}/teams`, { method: "POST", body: { name: "Saturday Reds" } });
const teamB = await call(`/api/leagues/${leagueId}/teams`, { method: "POST", body: { name: "Sunday Blues" } });
check("two real teams created", teamA.status === 201 && teamB.status === 201);

const players = [];
const mk = async (name, position, teamId, n) => {
  const r = await call(`/api/leagues/${leagueId}/players`, {
    method: "POST",
    body: { fullName: name, position, teamId, shirtNumber: n, availability: "available" },
  });
  if (r.data?.player) players.push({ ...r.data.player, teamId });
};
for (let i = 1; i <= 2; i++) await mk(`Reds Keeper ${i}`, "GK", teamA.data.team.id, i);
for (let i = 1; i <= 4; i++) await mk(`Reds Defender ${i}`, "DEF", teamA.data.team.id, i + 10);
for (let i = 1; i <= 4; i++) await mk(`Reds Mid ${i}`, "MID", teamA.data.team.id, i + 20);
for (let i = 1; i <= 3; i++) await mk(`Reds Fwd ${i}`, "FWD", teamA.data.team.id, i + 30);
for (let i = 1; i <= 2; i++) await mk(`Blues Keeper ${i}`, "GK", teamB.data.team.id, i + 40);
for (let i = 1; i <= 4; i++) await mk(`Blues Defender ${i}`, "DEF", teamB.data.team.id, i + 50);
for (let i = 1; i <= 4; i++) await mk(`Blues Mid ${i}`, "MID", teamB.data.team.id, i + 60);
for (let i = 1; i <= 3; i++) await mk(`Blues Fwd ${i}`, "FWD", teamB.data.team.id, i + 70);
check("20 league players registered", players.length === 20, `count=${players.length}`);

const other = await call("/api/leagues", { method: "POST", body: { name: "Other League", format: "7v7" } });
const otherId = other.data?.league?.id;
const otherRoster = await call(`/api/leagues/${otherId}/players`);
check("players are isolated per league", Array.isArray(otherRoster.data?.players) && otherRoster.data.players.length === 0, `sees ${otherRoster.data?.players?.length}`);

const reds = players.filter((p) => p.teamId === teamA.data.team.id);
const blues = players.filter((p) => p.teamId === teamB.data.team.id);

const entriesFor = (list, startersCount) =>
  list.map((p, i) => ({
    playerId: p.id,
    slot: i < startersCount ? "starter" : i < startersCount + 5 ? "sub" : "reserve",
    order: i,
  }));

const badSquad = await call(`/api/leagues/${leagueId}/squad`, {
  method: "PUT",
  body: {
    formation: "1-2-1",
    captainId: reds[1].id,
    viceCaptainId: reds[2].id,
    entries: entriesFor(players.slice(0, 15), 11),
  },
});
check("11 starters rejected in a 5v5 league", badSquad.status === 422, `status=${badSquad.status}`);

const gk = reds.find((p) => p.position === "GK");
const outfield = reds.filter((p) => p.position !== "GK").slice(0, 4);
const starters = [gk, ...outfield];
const subs = [...reds.filter((p) => !starters.includes(p)), ...blues].slice(0, 5);
const reserves = players.filter((p) => !starters.includes(p) && !subs.includes(p)).slice(0, 5);
const allSquad = [...starters, ...subs, ...reserves];
const goodEntries = allSquad.map((p, i) => ({
  playerId: p.id,
  slot: i < 5 ? "starter" : i < 10 ? "sub" : "reserve",
  order: i < 10 ? i % 5 : i,
}));
const goodSquad = await call(`/api/leagues/${leagueId}/squad`, {
  method: "PUT",
  body: {
    formation: "1-2-1",
    captainId: starters[1].id,
    viceCaptainId: starters[2].id,
    entries: goodEntries,
  },
});
check("valid 15-player 5v5 squad saved", goodSquad.status === 200 && goodSquad.data?.valid === true, `status=${goodSquad.status} ${JSON.stringify(goodSquad.data ?? goodSquad.data).slice(0, 220)}`);

const match = await call("/api/matches", {
  method: "POST",
  body: {
    leagueId,
    teamAId: teamA.data.team.id,
    teamBId: teamB.data.team.id,
    title: "Round 1 — Tuesday",
    kickOff: new Date(Date.now() + 3600_000).toISOString(),
  },
});
const matchId = match.data?.match?.id;
check("real match created", match.status === 201 && matchId, `status=${match.status}`);

const redsGK = reds.find((p) => p.position === "GK");
const bluesGK = blues.find((p) => p.position === "GK");
const redsOut = reds.filter((p) => p.position !== "GK").slice(0, 4);
const bluesOut = blues.filter((p) => p.position !== "GK").slice(0, 4);

const shortLineup = await call(`/api/matches/${matchId}/lineup`, {
  method: "PUT",
  body: { teamId: teamA.data.team.id, starters: [redsGK.id, redsOut[0].id, redsOut[1].id], subs: [] },
});
check("under-strength lineup rejected (needs exactly 5)", shortLineup.status === 422, `status=${shortLineup.status}`);

const noKeeper = await call(`/api/matches/${matchId}/lineup`, {
  method: "PUT",
  body: { teamId: teamA.data.team.id, starters: redsOut.map((p) => p.id), subs: [] },
});
check("lineup without a goalkeeper rejected", noKeeper.status === 422, `status=${noKeeper.status}`);

const lineupA = await call(`/api/matches/${matchId}/lineup`, {
  method: "PUT",
  body: { teamId: teamA.data.team.id, starters: [redsGK.id, ...redsOut.map((p) => p.id)], subs: [reds[5].id] },
});
const lineupB = await call(`/api/matches/${matchId}/lineup`, {
  method: "PUT",
  body: { teamId: teamB.data.team.id, starters: [bluesGK.id, ...bluesOut.map((p) => p.id)], subs: [blues[5].id] },
});
check("both lineups accepted", lineupA.status === 200 && lineupB.status === 200, `A=${lineupA.status} B=${lineupB.status}`);

const early = await call(`/api/matches/${matchId}/flow`, { method: "POST", body: { action: "submit" } });
check("submission blocked while scoring rules are draft", early.status === 409, `status=${early.status} ${early.data?.error ?? ""}`);

const approvedRules = await call(`/api/leagues/${leagueId}/rules`, { method: "PUT", body: { action: "approve" } });
check("leader approves the scoring rules", approvedRules.data?.approved === true, `status=${approvedRules.status}`);

const goal = await call(`/api/matches/${matchId}/events`, {
  method: "POST",
  body: {
    teamId: teamA.data.team.id,
    playerId: redsOut[3].id,
    assistPlayerId: redsOut[2].id,
    eventType: "goal",
    minute: 23,
  },
});
const card = await call(`/api/matches/${matchId}/events`, {
  method: "POST",
  body: { teamId: teamB.data.team.id, playerId: bluesOut[0].id, eventType: "yellow_card", minute: 41 },
});
check("goal + yellow card recorded", goal.status === 201 && card.status === 201, `goal=${goal.status} card=${card.status}`);

const badEvent = await call(`/api/matches/${matchId}/events`, {
  method: "POST",
  body: { teamId: teamB.data.team.id, playerId: redsOut[0].id, eventType: "goal", minute: 5 },
});
check("event for a player outside the lineup rejected", badEvent.status === 422, `status=${badEvent.status}`);

const submit = await call(`/api/matches/${matchId}/flow`, { method: "POST", body: { action: "submit" } });
check("match submitted → pending", submit.data?.status === "pending", `status=${submit.status} ${JSON.stringify(submit.data ?? {}).slice(0, 200)}`);

const selfApprove = await call(`/api/matches/${matchId}/flow`, { method: "POST", body: { action: "approve" } });
check("self-approval allowed by policy", selfApprove.status === 200, `status=${selfApprove.status} ${JSON.stringify(selfApprove.data ?? {}).slice(0, 200)}`);

const points = await call(`/api/leagues/${leagueId}/points`);
check("player points calculated from approved events", (points.data?.rows?.length ?? 0) > 0, `rows=${points.data?.rows?.length}`);

const standings = await call(`/api/leagues/${leagueId}/standings`);
check("standings rebuilt for the league", (standings.data?.standings?.length ?? 0) === 1, `rows=${standings.data?.standings?.length}`);
const total = Number(standings.data?.standings?.[0]?.totalPoints ?? -1);
check("points landed in the manager total", total > 0, `total=${total}`);

const again = await call(`/api/matches/${matchId}/flow`, { method: "POST", body: { action: "approve" } });
check("re-approving an approved match is refused", again.status === 409, `status=${again.status}`);

const pointsAgain = await call(`/api/leagues/${leagueId}/points`);
check(
  "recalculation did not duplicate rows",
  (pointsAgain.data?.rows?.length ?? 0) === (points.data?.rows?.length ?? 0),
  `${pointsAgain.data?.rows?.length} vs ${points.data?.rows?.length}`,
);

const opId = crypto.randomUUID();
const first = await fetch(BASE + "/api/leagues", {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie, "x-operation-id": opId },
  body: JSON.stringify({ name: "Idempotent League", format: "7v7" }),
});
const f1 = await first.json();
const second = await fetch(BASE + "/api/leagues", {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie, "x-operation-id": opId },
  body: JSON.stringify({ name: "Idempotent League", format: "7v7" }),
});
const f2 = await second.json();
check(
  "replayed operation id does not create a second league",
  f1.league?.id && f1.league.id === f2.league?.id,
  `${f1.league?.id} vs ${f2.league?.id}`,
);

const myLeagues = await call("/api/leagues");
check("exactly three leagues exist", myLeagues.data?.leagues?.length === 3, `count=${myLeagues.data?.leagues?.length}`);

const sevenId = f2.league?.id;
const sevenSquad = await call(`/api/leagues/${sevenId}/squad`, {
  method: "PUT",
  body: { formation: "1-2-3", entries: [] },
});
check("7v7 league rejects an incomplete squad", sevenSquad.status === 422, `status=${sevenSquad.status}`);

const notifications = await call("/api/notifications");
check("notifications endpoint responds", notifications.status === 200, `status=${notifications.status}`);

const logout = await call("/api/auth/logout", { method: "POST" });
const afterLogout = await fetch(BASE + "/api/auth/session", { headers: { cookie } });
const after = await afterLogout.json();
check("logout clears the session", logout.status === 200 && after.user === null, `user=${JSON.stringify(after.user)}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILURES:\n" + failed.map((f) => ` - ${f.name} ${f.extra}`).join("\n"));
  process.exit(1);
}
