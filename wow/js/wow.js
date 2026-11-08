// WoW Harvester front end.
// Blizzard's API needs an OAuth client secret, which must never be shipped in a
// public static site, so this page talks to our backend Worker instead.
//
// Which backend:
//  - page opened from localhost / 127.0.0.1 (docker compose "site" service):
//    the local backend at http://localhost:8787
//  - anywhere else (the live github.io site): PRODUCTION_API, once deployed
const PRODUCTION_API = "https://wow-harvester-api.ausinater.workers.dev";
const LOCAL_API = "http://localhost:8787";
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = IS_LOCAL ? LOCAL_API : PRODUCTION_API;

const form = document.getElementById("lookup-form");
const result = document.getElementById("lookup-result");
const statusText = document.getElementById("status-text");

// Realm name -> Blizzard slug: "Arugal (AU)" -> "arugal-au", "Kel'Thuzad" -> "kelthuzad".
function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s-]+/g, "-");
}

// WoW Forever has no realms: characters are Name + Surname, and the backend's
// realm segment carries the surname (lowercase, spaces as hyphens, accents kept).
const slugSurname = (s) => s.trim().toLowerCase().replace(/\s+/g, "-");
const slugPlace = (game, value) => (game === "forever" ? slugSurname(value) : slugify(value));
const displayName = (c) => c.fullName ?? c.name ?? c.key;

// Search form: the second field is "Surname" for Forever, "Realm" otherwise.
function syncPlaceField() {
  const forever = form.elements.game.value === "forever";
  document.getElementById("realm-label").textContent = forever ? "Surname" : "Realm";
  form.elements.realm.placeholder = forever ? "e.g. Stormbrew" : "e.g. Arugal (AU)";
  form.elements.character.placeholder = forever ? "e.g. Mezric" : "e.g. Raxxedm";
}
form.elements.game.addEventListener("change", syncPlaceField);
syncPlaceField();

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null);

// Small helper to build elements without innerHTML (names come from the API).
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

async function api(path) {
  const res = await fetch(API_BASE + path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Status card: show whether the backend is reachable.
async function checkBackend() {
  if (!API_BASE) {
    statusText.textContent = "Backend not connected yet. Live data will appear here once it's deployed.";
    return;
  }
  try {
    const s = await api("/status");
    const where = IS_LOCAL ? "local test backend" : "backend";
    const tracked = s.counts ? `, ${s.counts.tracked} tracked character${s.counts.tracked === 1 ? "" : "s"}` : "";
    const problems = [];
    if (!s.keysConfigured) problems.push("Blizzard keys missing");
    if (!s.database) problems.push("database not ready");
    statusText.textContent = `Connected to the ${where}${tracked}.` + (problems.length ? ` Problems: ${problems.join(", ")}.` : "");
    return s;
  } catch (err) {
    statusText.textContent = IS_LOCAL
      ? `Can't reach the local backend at ${LOCAL_API} (${err.message}). Is "docker compose up" running?`
      : `Can't reach the backend right now (${err.message}).`;
  }
}

// The character currently shown, for the lifetime stats button.
let current = null;

function showCharacter(c, lookup) {
  current = lookup;
  result.replaceChildren();
  result.append(el("h3", `${displayName(c)} — ${c.realm}`));
  result.append(el("p", `Level ${c.level} ${c.race ?? ""} ${c.class ?? ""}${c.spec ? ` (${c.spec})` : ""}`.replace(/\s+/g, " ")));

  const m = c.metrics ?? {};
  const rows = [
    ["Guild", c.guild],
    ["Faction", c.faction],
    ["Item level", fmt(c.itemLevel)],
    ["Achievement points", fmt(c.achievementPoints)],
    ["M+ rating", fmt(m.mythicRating)],
    ["Honorable kills", fmt(m.honorableKills)],
    ["Battleground HKs", fmt(m.bgHonorableKills)],
    ["Profession skill", fmt(m.professionSkill)],
    ["Mounts", fmt(m.mounts)],
    ["Exalted factions", fmt(m.exaltedFactions)],
    ["Quests completed", fmt(m.questsCompleted)],
    ["Deaths", fmt(m.deaths)],
  ].filter(([, v]) => v !== null && v !== undefined);

  const dl = el("dl", undefined, "stats");
  for (const [label, value] of rows) dl.append(el("dt", label), el("dd", String(value)));
  result.append(dl);

  if (!c.metrics) {
    result.append(el("p", "Weekly stats appear once this character is tracked (/wowtrack in Discord).", "hint"));
  }

  const btn = el("button", "View lifetime stats", "secondary");
  btn.type = "button";
  btn.addEventListener("click", () => loadLifetime(btn));
  result.append(btn);
  result.append(el("div", undefined, "lifetime"));
}

// ---- Lifetime stats -------------------------------------------------------

async function loadLifetime(btn) {
  const box = result.querySelector(".lifetime");
  const { region, realm, character, game } = current;
  btn.disabled = true;
  btn.textContent = "Loading lifetime stats...";
  try {
    const data = await api(`/character/${region}/${realm}/${encodeURIComponent(character)}/lifetime?game=${game}`);
    renderLifetime(box, data);
    btn.remove();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "View lifetime stats";
    box.replaceChildren(el("p", `Couldn't load lifetime stats: ${err.message}`, "hint"));
  }
}

const fmtValue = (item) => {
  if (item.type === "date") return new Date(item.value).toLocaleString();
  return typeof item.value === "number" ? fmt(item.value) : String(item.value ?? "");
};

function itemList(items) {
  const dl = el("dl", undefined, "stats");
  for (const it of items) {
    const dd = el("dd", fmtValue(it), it.quality ? `q-${it.quality}` : undefined);
    if (it.detail) dd.append(el("span", ` ${it.detail}`, "muted"));
    dl.append(el("dt", it.label), dd);
  }
  return dl;
}

function renderLifetime(box, data, idPrefix = "life") {
  box.replaceChildren();
  box.append(el("h3", "Lifetime stats"));
  const nav = el("nav", undefined, "section-nav");
  nav.setAttribute("role", "tablist");
  box.append(nav);

  const tabs = [];
  const select = (index) => {
    tabs.forEach(({ tab, sec }, i) => {
      const on = i === index;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      sec.hidden = !on;
    });
  };
  // Arrow keys move between tabs (standard tab behaviour).
  nav.addEventListener("keydown", (e) => {
    const i = tabs.findIndex((t) => t.tab === document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const next = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    select(next);
    tabs[next].tab.focus();
  });

  for (const section of data.sections) {
    const sec = el("section", undefined, "life-section");
    sec.id = `${idPrefix}-${section.id}`;
    sec.setAttribute("role", "tabpanel");
    const tab = el("button", section.title, "tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", sec.id);
    const index = tabs.length;
    tab.addEventListener("click", () => select(index));
    nav.append(tab);
    tabs.push({ tab, sec });

    const head = el("div", undefined, "life-head");
    if (section.image) {
      const img = el("img");
      img.src = section.image;
      img.alt = `${data.fullName ?? data.name} portrait`;
      img.className = "portrait";
      head.append(img);
    }
    head.append(el("h4", section.title));
    sec.append(head);

    if (section.items?.length) sec.append(itemList(section.items));

    // Statistic groups: open when a tab only has a few, collapsed otherwise.
    const openByDefault = (section.groups?.length ?? 0) <= 2 && section.id !== "statistics";
    for (const g of section.groups ?? []) {
      const det = el("details");
      det.open = openByDefault;
      det.append(el("summary", `${g.title} (${g.items.length})`));
      det.append(itemList(g.items));
      sec.append(det);
    }
    box.append(sec);
  }
  select(0);

  box.append(el("p", `Data from Blizzard's API, fetched ${new Date(data.fetchedAt).toLocaleString()}.`, "hint"));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const region = data.get("region");
  const game = data.get("game");
  let place = data.get("realm");
  let character = data.get("character").trim();
  // "Mezric Stormbrew" typed into Character for Forever: split it.
  const split = character.match(/^(\S+)[\s-]+(.+)$/);
  if (game === "forever" && split && !place.trim()) [, character, place] = split;
  result.hidden = false;
  if (!place.trim()) {
    result.textContent = game === "forever" ? "Add the character's surname." : "Add the character's realm.";
    return;
  }
  const realm = slugPlace(game, place);
  character = character.toLowerCase();

  result.hidden = false;

  if (!API_BASE) {
    result.textContent = `Backend not connected yet. Would look up ${character} ${realm} (${region.toUpperCase()}, ${game}).`;
    return;
  }

  result.textContent = "Loading...";
  try {
    const c = await api(`/character/${region}/${realm}/${encodeURIComponent(character)}?game=${game}`);
    showCharacter(c, { region, realm, character, game });
  } catch (err) {
    result.textContent = `Lookup failed: ${err.message}`;
  }
});

// ---- Shared display helpers ----------------------------------------------

const CLASS_COLORS = {
  "Death Knight": "#c41e3a", "Demon Hunter": "#a330c9", Druid: "#ff7c0a", Evoker: "#33937f",
  Hunter: "#aad372", Mage: "#3fc7eb", Monk: "#00ff98", Paladin: "#f48cba", Priest: "#ffffff",
  Rogue: "#fff468", Shaman: "#0070dd", Warlock: "#8788ee", Warrior: "#c69b6d",
};
const COMMENDATION_EMOJI = {
  chum: "🦈", business: "💼", grass: "🌱", levels: "⬆️", gear: "🛡️", keystone: "🗝️", achievements: "🎖️",
  mounts: "🐎", quests: "📜", deaths: "💀", ghost: "👻",
};
const commendationsOf = (r) => r?.commendations ?? r?.awards ?? [];
const playersOf = (r) => r?.players ?? r?.leaderboard ?? [];
const METRIC_LABELS = {
  level: "Levels", itemLevel: "Item level", mythicRating: "M+ rating", achievementPoints: "Achievements",
  mounts: "Mounts", honorableKills: "Honorable kills", questsCompleted: "Quests", deaths: "Deaths",
  professionSkill: "Profession skill", exaltedFactions: "Exalted factions", bgHonorableKills: "Battleground HKs",
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function timeAgo(ms) {
  if (!ms) return null;
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

function message(container, text) {
  container.replaceChildren(el("p", text, "muted"));
}

// The game shown in Player Status / Chum Commendations: the backend's default game.
let groupGame = "forever";

// ---- 1. Player Status ------------------------------------------------------
// Boilerplate for now: one card per tracked character, padded to GROUP_SIZE.

const GROUP_SIZE = 6;

async function loadPlayers() {
  const grid = document.getElementById("player-grid");
  if (!API_BASE) return message(grid, "Backend not connected yet.");
  message(grid, "Loading players...");
  try {
    const [roster, report] = await Promise.all([
      api(`/roster?game=${groupGame}`),
      api(`/reports/weekly?week=current&game=${groupGame}`).catch(() => null),
    ]);
    const week = new Map(playersOf(report).map((p) => [p.key, p]));
    // Commendations each player currently leads this week.
    const holding = new Map();
    for (const a of commendationsOf(report)) {
      const n = a.winners[0]?.name;
      if (!n) continue;
      if (!holding.has(n)) holding.set(n, []);
      holding.get(n).push(`${COMMENDATION_EMOJI[a.id] ?? "🏅"} ${a.title}`);
    }
    grid.replaceChildren();
    for (const c of roster.characters) {
      grid.append(playerCard(c, week.get(`${c.game}/${c.region}/${c.realmSlug}/${c.key}`), holding.get(displayName(c)) ?? []));
    }
    for (let i = roster.characters.length; i < GROUP_SIZE; i++) grid.append(emptySlot());
    document.getElementById("players-sub").textContent =
      `${plural(roster.count, "tracked character")}. This week's numbers update every 15 minutes.`;
  } catch (err) {
    message(grid, `Couldn't load players: ${err.message}`);
  }
}

function playerCard(c, wk, holding) {
  const card = el("article", undefined, "player-card");
  card.style.borderTopColor = CLASS_COLORS[c.class] ?? "var(--accent)";
  card.append(el("h3", displayName(c)));
  card.append(el("p", `${c.level ? `Level ${c.level} ` : ""}${c.race ?? ""} ${c.class ?? ""}`.replace(/\s+/g, " ").trim(), "muted"));

  const m = c.metrics ?? {};
  const rows = [
    [c.game === "forever" ? "Ruleset" : "Realm", c.realm ?? c.realmSlug],
    ["Item level", fmt(c.itemLevel)],
    ["Sessions", wk?.activity ? `${wk.activity.sessions} (${plural(wk.activity.daysPlayed, "day")})` : "—"],
    ["Profession skill", fmt(m.professionSkill)],
    ["Battleground HKs", fmt(m.bgHonorableKills)],
    ["Last logout", timeAgo(c.lastLogin)],
  ].filter(([, v]) => v !== null && v !== undefined);
  const dl = el("dl", undefined, "stats");
  for (const [k, v] of rows) dl.append(el("dt", k), el("dd", String(v)));
  card.append(dl);
  if (holding.length) {
    const h = el("div", undefined, "holding");
    h.append(el("span", "Leading this week:", "muted small"));
    for (const t of holding) h.append(el("span", t, "badge"));
    card.append(h);
  }
  const more = el("a", "See all data →", "see-all");
  more.href = `#${playerPath(c)}`;
  card.append(more);
  return card;
}

// ---- Player detail ("See all data") -------------------------------------------
// Everything stored for one tracked character: profile, current totals, this
// week, the last snapshot of each of the last 30 days, Blizzard's lifetime
// stats, and the raw JSON.

const playerPath = (c) =>
  ["players", c.game, c.region, c.realmSlug, c.key].map(encodeURIComponent).join("/");

const playersOverview = document.getElementById("players-overview");
const playerDetail = document.getElementById("player-detail");

function showPlayersOverview() {
  playerDetail.hidden = true;
  playersOverview.hidden = false;
}

async function showPlayerDetail([game, region, realm, name]) {
  playersOverview.hidden = true;
  playerDetail.hidden = false;
  playerDetail.replaceChildren();
  const back = el("a", "← All players", "back-link");
  back.href = "#players";
  playerDetail.append(back);
  if (!API_BASE) return playerDetail.append(el("p", "Backend not connected yet.", "muted"));
  const body = el("div");
  playerDetail.append(body);
  message(body, "Loading everything we have...");

  const base = `/character/${region}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
  try {
    const [history, report, lifetime] = await Promise.all([
      api(`${base}/history?game=${game}`),
      api(`/reports/weekly?week=current&game=${game}`).catch(() => null),
      api(`${base}/lifetime?game=${game}`).catch((err) => ({ error: err.message })),
    ]);
    renderPlayerDetail(body, history, playersOf(report).find((p) => p.key === `${game}/${region}/${realm}/${name}`), lifetime);
  } catch (err) {
    message(body, `Couldn't load this character: ${err.message}`);
  }
}

function section(title, ...children) {
  const s = el("section", undefined, "detail-section");
  s.append(el("h3", title), ...children);
  return s;
}

function dlOf(rows) {
  const dl = el("dl", undefined, "stats");
  for (const [k, v] of rows) if (v !== null && v !== undefined && v !== "") dl.append(el("dt", k), el("dd", String(v)));
  return dl;
}

function renderPlayerDetail(box, h, wk, lifetime) {
  const c = h.character ?? {};
  const m = c.metrics ?? {};
  const info = h.metricInfo ?? {};
  const label = (k) => info[k]?.label ?? k;
  box.replaceChildren();

  const head = el("div", undefined, "detail-head");
  head.style.borderLeftColor = CLASS_COLORS[c.class] ?? "var(--accent)";
  head.append(el("h2", displayName(c)));
  head.append(el("p", [
    c.level ? `Level ${c.level}` : null, c.race, c.class, c.spec ? `(${c.spec})` : null,
  ].filter(Boolean).join(" "), "muted"));
  box.append(head);

  // Profile + tracking
  box.append(section("Profile", dlOf([
    ["Name", c.name],
    ["Surname", c.surname],
    [c.game === "forever" ? "Ruleset" : "Realm", c.realm ?? h.realmSlug],
    ["Region", h.region?.toUpperCase()],
    ["Game", h.game],
    ["Faction", c.faction],
    ["Guild", c.guild],
    ["Item level", fmt(c.itemLevel)],
    ["Achievement points", fmt(c.achievementPoints)],
    ["Last logout", c.lastLogin ? new Date(c.lastLogin).toLocaleString() : null],
  ])));
  box.append(section("Tracking", dlOf([
    ["Tracked since", h.tracked?.addedAt ? new Date(h.tracked.addedAt).toLocaleString() : null],
    ["Added by", h.tracked?.addedBy],
    ["Last refreshed", timeAgo(h.tracked?.lastHarvestedAt)],
    ["Snapshots stored", h.snapshots?.count ? `${fmt(h.snapshots.count)} (since ${new Date(h.snapshots.first).toLocaleDateString()})` : "none yet"],
  ]), el("p", "A snapshot is saved every 15 minutes and kept for 30 days.", "hint")));

  // Current totals: every tracked stat
  const keys = Object.keys(info);
  box.append(section("Current totals", dlOf(keys.map((k) => [label(k), fmt(m[k]) ?? "—"]))));

  // This week
  const weekRows = keys.map((k) => [label(k), wk?.gains?.[k] !== undefined ? `+${fmt(wk.gains[k])}` : "—"]);
  if (wk?.activity) weekRows.unshift(["Play sessions", `${wk.activity.sessions} over ${plural(wk.activity.daysPlayed, "day")}`]);
  box.append(section("This week so far", wk ? dlOf(weekRows) : el("p", "No data for this week yet.", "muted")));

  // Daily history table
  const days = [...(h.days ?? [])].reverse(); // newest first
  const cols = keys.filter((k) => days.some((d) => typeof d.metrics?.[k] === "number"));
  if (days.length && cols.length) {
    const wrap = el("div", undefined, "table-wrap");
    const table = el("table", undefined, "history");
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", "Day"));
    for (const k of cols) hr.append(el("th", label(k)));
    thead.append(hr);
    const tbody = el("tbody");
    days.forEach((d, i) => {
      const prev = days[i + 1];
      const tr = el("tr");
      tr.append(el("th", new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })));
      for (const k of cols) {
        const v = d.metrics[k];
        const td = el("td", typeof v === "number" ? fmt(v) : "—");
        const delta = typeof v === "number" && typeof prev?.metrics?.[k] === "number" ? v - prev.metrics[k] : 0;
        if (delta) td.append(el("span", ` ${delta > 0 ? "+" : ""}${fmt(delta)}`, delta > 0 ? "up" : "down"));
        tr.append(td);
      }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    box.append(section("Last 30 days", el("p", "End-of-day totals, with the change from the day before.", "hint"), wrap));
  } else {
    box.append(section("Last 30 days", el("p", "No history yet. It builds up every 15 minutes once a character is tracked.", "muted")));
  }

  // Lifetime (live from Blizzard)
  const life = el("div", undefined, "lifetime");
  if (lifetime?.sections) renderLifetime(life, lifetime, "detail-life");
  else life.append(el("p", `Couldn't load lifetime stats: ${lifetime?.error ?? "unknown error"}`, "hint"));
  box.append(life);

  // Raw data
  const raw = el("details", undefined, "raw");
  raw.append(el("summary", "Raw data (JSON)"));
  raw.append(el("pre", JSON.stringify({ stored: h, thisWeek: wk ?? null }, null, 2)));
  box.append(section("Everything else", raw));
}

function emptySlot() {
  const card = el("article", undefined, "player-card empty");
  card.append(el("h3", "Open slot"));
  card.append(el("p", "Add a character with /wowtrack in Discord.", "muted"));
  return card;
}

// ---- 2. Chum Commendations ------------------------------------------------------

const weekSelect = document.getElementById("week-select");
let weeksLoaded = false;

async function loadAwardsPanel() {
  if (!API_BASE) return message(document.getElementById("award-grid"), "Backend not connected yet.");
  if (!weeksLoaded) {
    try {
      const { weeks } = await api(`/reports/weeks?game=${groupGame}`);
      weekSelect.replaceChildren();
      for (const w of weeks) {
        const num = w.number ? `Week ${w.number}` : "Week";
        const label = w.current ? `${num}: this week (from ${w.week}, so far)` : `${num} (from ${w.week})${w.final ? "" : ", not final yet"}`;
        const opt = el("option", label);
        opt.value = w.current ? "current" : w.week;
        weekSelect.append(opt);
      }
      weeksLoaded = true;
    } catch (err) {
      return message(document.getElementById("award-grid"), `Couldn't load weeks: ${err.message}`);
    }
  }
  loadAwards(weekSelect.value || "current");
}

weekSelect.addEventListener("change", () => loadAwards(weekSelect.value));

async function loadAwards(week) {
  const grid = document.getElementById("award-grid");
  const everyone = document.getElementById("everyone");
  const activity = document.getElementById("activity");
  message(grid, "Loading commendations...");
  everyone.replaceChildren();
  activity.replaceChildren();
  try {
    const r = await api(`/reports/weekly?week=${encodeURIComponent(week)}&game=${groupGame}`);
    document.getElementById("awards-sub").textContent = r.complete
      ? `Final results for week ${r.weekNumber ?? ""} (from ${r.weekStart}).`.replace("week  (", "the week (")
      : `Week ${r.weekNumber ?? ""} (from ${r.weekStart}), in progress: commendations can still change hands until Sunday 8 a.m.`;

    grid.replaceChildren();
    const list = commendationsOf(r);
    if (!list.length) message(grid, "Nothing to hand out yet: not enough data for this week.");
    for (const a of list) grid.append(awardCard(a));

    // What each player did, alphabetical (no ranking).
    for (const p of playersOf(r)) {
      const li = el("li");
      li.append(el("strong", p.name));
      const gains = Object.entries(p.gains ?? {}).filter(([, v]) => v > 0)
        .map(([k, v]) => `${METRIC_LABELS[k] ?? k} +${fmt(v)}`);
      li.append(el("div", gains.length ? gains.join(" · ") : "Nothing recorded yet", "muted"));
      everyone.append(li);
    }
    if (!playersOf(r).length) everyone.append(el("li", "No tracked characters for this week.", "muted"));

    for (const p of r.activity ?? []) {
      const li = el("li");
      li.append(el("strong", p.name), el("span", ` ${plural(p.sessions, "session")} · ${p.daysPlayed}/7 days`, "pts"));
      activity.append(li);
    }
    if (!(r.activity ?? []).length) activity.append(el("li", "No activity data for this week.", "muted"));
  } catch (err) {
    message(grid, `Couldn't load commendations: ${err.message}`);
  }
}

function awardCard(a) {
  const card = el("article", undefined, "award-card");
  const [first, ...rest] = a.winners;
  card.append(el("div", COMMENDATION_EMOJI[a.id] ?? "🏅", "award-emoji"));
  card.append(el("h3", a.title));
  card.append(el("p", a.blurb, "muted"));
  const win = el("p", undefined, "winner");
  win.append(el("strong", first.name), el("span", ` ${fmt(first.value)}`, "pts"));
  card.append(win);
  if (first.note) card.append(el("p", first.note, "muted small"));
  if (rest.length) card.append(el("p", `Runners-up: ${rest.map((w) => `${w.name} (${fmt(w.value)})`).join(", ")}`, "muted small"));
  return card;
}

// ---- Top-level tabs ----------------------------------------------------------

const PANELS = ["players", "commendations", "search"];
const loaded = new Set();

function showPanel(hash) {
  const [panel, ...rest] = hash.split("/").map(decodeURIComponent);
  let name = panel;
  if (!PANELS.includes(name)) name = "players";
  if (name === "players") {
    if (rest.length === 4) showPlayerDetail(rest);
    else showPlayersOverview();
  }
  if (rest.length === 4) window.scrollTo(0, 0);
  for (const p of PANELS) {
    document.getElementById(`panel-${p}`).hidden = p !== name;
    const tab = document.querySelector(`.main-tab[data-panel="${p}"]`);
    tab.classList.toggle("active", p === name);
    tab.setAttribute("aria-selected", String(p === name));
  }
  if (!loaded.has(name)) {
    loaded.add(name);
    if (name === "players") loadPlayers();
    if (name === "commendations") loadAwardsPanel();
  }
}

window.addEventListener("hashchange", () => showPanel(location.hash.slice(1)));

(async () => {
  const status = await checkBackend();
  if (status?.defaultGame) groupGame = status.defaultGame;
  showPanel(location.hash.slice(1));
})();
