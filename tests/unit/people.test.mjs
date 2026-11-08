// People and Companies (cloudflare/src/people.js) on node:sqlite, plus the page HTML.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const P = await import(SRC + "people.js");
const V = await import(SRC + "views.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

// D1 accepts numbered parameters (?1, ?2); node:sqlite's positional binding doesn't, so expand them.
function d1(sqlite) {
  const numbered = (sql, args) => {
    if (!/\?\d/.test(sql)) return [sql, args];
    const out = [];
    return [sql.replace(/\?(\d+)/g, (_, i) => { out.push(args[i - 1]); return "?"; }), out];
  };
  const stmt = (rawSql, rawArgs = []) => { const [sql, args] = numbered(rawSql, rawArgs); return {
    bind: (...a) => stmt(rawSql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  }; };
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); return []; } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);
const kv = new Map([["find:org:stripe.com", "Stripe, Inc."]]);
const env = { DB: db, DOCS: { get: async k => kv.get(k) ?? null } };
const now = () => Date.now() / 1000;
const H = 3600, D = 86400;

// ---- helpers ----
check("org domain: subdomains belong to the company", P.orgDomain("eu.jobs.stripe.com") === "stripe.com" && P.orgDomain("mail.acme.co.uk") === "acme.co.uk" && P.orgDomain("figma.com") === "figma.com", "");
check("personal addresses: webmail, not companies", P.isPersonal("gmail.com") && P.isPersonal("outlook.com") && P.isPersonal("yahoo.co.uk") && P.isPersonal("icloud.com") && !P.isPersonal("mail.acme.com") && !P.isPersonal("stripe.com"), "");
check("company label: title-cased domain", P.companyLabel("acme-labs.io") === "Acme Labs" && P.companyLabel("eu.figma.com") === "Figma", P.companyLabel("acme-labs.io"));
check("usual window: needs 3 opens", P.usualWindow([9, 9]) === null, "");
const w = P.usualWindow([9, 9, 10, 10, 15, 22]);
check("usual window: the 2-hour slot most opens fall in", w && w.start === 9 && w.n === 4 && w.total === 6, w);
check("usual window: no clear favourite -> none", P.usualWindow([1, 5, 9, 13, 17, 21]) === null, "");
check("usual window: wraps past midnight", P.usualWindow([23, 23, 0, 0, 12]).start === 23, P.usualWindow([23, 23, 0, 0, 12]));
check("hour ranges read naturally", P.hourRange(9) === "9–11 AM" && P.hourRange(11) === "11 AM–1 PM" && P.hourRange(22) === "10 PM–12 AM" && P.hourRange(0) === "12–2 AM", [P.hourRange(9), P.hourRange(11), P.hourRange(22), P.hourRange(0)]);

// ---- data ----
await (await import(SRC + "google.js")).ensureGoogleSchema(db);
const uid = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES('me@x.com','x','k',1,1)").run().lastInsertRowid);
const other = Number(sqlite.prepare("INSERT INTO users(email,password_hash,api_key,is_admin,created_at) VALUES('you@x.com','x','k2',0,1)").run().lastInsertRowid);
let n = 0;
function email(user, to, { name = null, ago = D, opens = 0, clicks = 0, last_open = null, replied = null, by = null, raddr = null, plan = null, scheduled = null } = {}) {
  return Number(sqlite.prepare(`INSERT INTO emails(token,to_addr,to_name,subject,created_at,scheduled_at,user_id,opens,clicks,last_open,replied_at,replied_by,replied_addr,retry_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("t" + ++n, to, name, "Subject " + n, now() - ago, scheduled, user, opens, clicks, last_open, replied, by, raddr,
    plan ? JSON.stringify({ name: plan, cands: [] }) : null).lastInsertRowid);
}
const ev = (eid, kind, ts, is_bot = 0, flagged = null) => sqlite.prepare("INSERT INTO events(email_id,kind,ts,is_bot,flagged) VALUES(?,?,?,?,?)").run(eid, kind, ts, is_bot, flagged);

const j1 = email(uid, "Jane@Stripe.com", { ago: 5 * D, opens: 3, last_open: now() - 4 * D });
const j2 = email(uid, "jane@stripe.com", { ago: 2 * D, replied: now() - D, by: "Jane Doe", raddr: "jane@stripe.com" });
const s1 = email(uid, "sam@eu.stripe.com", { ago: 3 * D, clicks: 1, plan: "Sam Lee" });
const f1 = email(uid, "kim@figma.com", { name: "Kim Park", ago: 10 * D });
const g1 = email(uid, "pal@gmail.com", { ago: H, opens: 1, last_open: now() - 60 });
const o1 = email(uid, "bob@outlook.com", { ago: 20 * D });
email(other, "jane@stripe.com", { ago: H, opens: 9 });          // someone else's email: never counted
// opens: a burst within 30 minutes counts once; bots / flagged ones never count
const base = Math.floor(now() / D) * D - 4 * D;
ev(j1, "open", base + 9 * H); ev(j1, "open", base + 9 * H + 600); ev(j1, "open", base + D + 9.5 * H); ev(j1, "open", base + 2 * D + 10 * H);
ev(j1, "open", base + 3 * D + 3 * H, 1, "prefetch"); ev(j1, "open", base + 3 * D + 4 * H, 0, "apple");
ev(s1, "click", now() - 2 * D);
ev(g1, "open", now() - 60);

const people = await P.loadPeople(db, uid);
const by = Object.fromEntries(people.map(p => [p.addr, p]));
const jane = by["jane@stripe.com"];
check("one row per person, addresses case-insensitive, only your emails", people.length === 5 && jane && jane.sent === 2, people.map(p => [p.addr, p.sent]));
check("totals: opened, clicked, replied", jane.opened === 1 && jane.replied === 1 && by["sam@eu.stripe.com"].clicked === 1, jane);
check("name from whoever replied, the auto-try plan, or what you typed", jane.name === "Jane Doe" && by["sam@eu.stripe.com"].name === "Sam Lee" && by["kim@figma.com"].name === "Kim Park" && by["bob@outlook.com"].name === "", people.map(p => p.name));
check("last contact = your latest email, last activity = their latest open/click/reply",
  Math.abs(jane.last_contact - (now() - 2 * D)) < 5 && Math.abs(jane.last_activity - (now() - D)) < 5 && Math.abs(by["sam@eu.stripe.com"].last_activity - (now() - 2 * D)) < 5, jane);
check("open times: genuine only, a burst counts once", jane.opens.length === 3 && !jane.opens.includes(base + 3 * D + 4 * H), jane.opens.map(t => (t - base) / H));
check("newest activity first", people[0].addr === "pal@gmail.com" && people[people.length - 1].addr === "bob@outlook.com", people.map(p => p.addr));

const names = await P.companyNames(env, people.filter(p => !p.personal).map(p => p.org));
const cos = P.groupCompanies(people, names);
const stripe = cos.find(c => c.key === "stripe.com");
check("companies: grouped by domain (subdomains too), named from the finder's memory", stripe && stripe.name === "Stripe, Inc." && stripe.people.length === 2 && stripe.sent === 3 && stripe.replied === 1, stripe);
check("companies: otherwise a title-cased domain label", cos.find(c => c.key === "figma.com").name === "Figma", cos.map(c => c.name));
const personal = cos[cos.length - 1];
check("webmail grouped as 'Personal addresses', listed last", personal.personal && personal.key === P.PERSONAL && personal.name === "Personal addresses" && personal.people.length === 2, cos.map(c => c.name));

const one = await P.loadPerson(db, uid, " JANE@stripe.com ");
check("person: their emails, newest first", one && one.emails.length === 2 && one.emails[0].id === j2 && one.person.sent === 2, one && one.emails.map(e => e.id));
check("person: someone you never emailed -> nothing", (await P.loadPerson(db, uid, "nobody@x.com")) === null, "");
check("person: another user's recipient is not visible", (await P.loadPerson(db, other, "kim@figma.com")) === null, "");

// ---- pages ----
const user = { id: uid, email: "me@x.com", name: "Me" };
let html = V.peoplePage({ user, people, companies: cos, names });
check("People page: in the top bar, a row per person, search box", html.includes('href="/people" class="on"') && html.includes('href="/people/jane%40stripe.com"') && html.includes('id="q"') && html.includes("Stripe, Inc."), "");
check("People page: open times for the 'usually opens' column", html.includes(`data-opens="${jane.opens.map(Math.round).join(",")}"`) && html.includes("function usualWindow"), "");
html = V.companiesPage({ user, companies: cos });
check("Companies page: companies link to their page, personal addresses separate", html.includes('href="/companies/stripe.com"') && html.includes('href="/companies/personal"') && html.includes("Personal addresses"), "");
html = V.personPage({ user, person: one.person, company: { key: "stripe.com", name: "Stripe, Inc." }, emails: one.emails });
check("Person page: Write opens a Gmail compose to them", html.includes("https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=jane%40stripe.com") && html.includes(">Write<"), "");
check("Person page: emails with statuses, open-time chart", html.includes(`data-href="/email/${j2}"`) && html.includes("st reply") && html.includes('id="hours"'), "");
html = V.companyPage({ user, company: stripe });
check("Company page: lists its people", html.includes('data-href="/people/jane%40stripe.com"') && html.includes('data-href="/people/sam%40eu.stripe.com"'), "");
// the inlined browser code still runs on its own
const fn = new Function(`var usualWindow = ${P.usualWindow.toString()}; var hourRange = ${P.hourRange.toString()}; return hourRange(usualWindow([14, 14, 15]).start);`);
check("inlined open-pattern code is self-contained", fn() === "2–4 PM", fn());

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
