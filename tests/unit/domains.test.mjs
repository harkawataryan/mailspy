// Your own tracking domain (cloudflare/src/domains.js), against a fake Cloudflare API.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const D = await import(SRC + "domains.js");
const V = await import(SRC + "views.js");
const P = await import(SRC + "prefs.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };
const throws = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: sql => stmt(sql) };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);

// ---- cleanHostname
const R = ["mailspy.aryanh.dev", "go.aryanh.dev", "aryanh.dev"];
check("cleans a pasted URL", D.cleanHostname("https://Go.Friend.com/path?x", R) === "go.friend.com");
check("needs a subdomain", /subdomain/.test(throws(() => D.cleanHostname("friend.com", R))));
check("rejects junk", /valid domain/.test(throws(() => D.cleanHostname("not a domain", R))));
check("rejects empty", /Enter a domain/.test(throws(() => D.cleanHostname("  ", R))));
check("rejects this server's domains", /belongs to this MailSpy/.test(throws(() => D.cleanHostname("x.aryanh.dev", R))));
check("rejects the tracking host itself", /belongs/.test(throws(() => D.cleanHostname("go.aryanh.dev", R))));
check("rejects an IP", /IP/.test(throws(() => D.cleanHostname("1.2.3.4", R))));
check("deeper subdomains are fine", D.cleanHostname("mail.go.friend.co.uk", R) === "mail.go.friend.co.uk");

// ---- hostnameState
check("active needs the certificate too", D.hostnameState({ status: "active", ssl: { status: "pending_validation" } }).status === "pending");
check("active + active = active", D.hostnameState({ status: "active", ssl: { status: "active" } }).status === "active");
check("blocked is an error", D.hostnameState({ status: "blocked", ssl: {} }).status === "error");
check("gone is an error", D.hostnameState(null).status === "error");
check("pending carries Cloudflare's reason", D.hostnameState({ status: "pending", ssl: { validation_errors: [{ message: "CNAME not found" }] } }).error === "CNAME not found");

// ---- fake Cloudflare
const cf = { hostnames: {}, routes: {}, n: 0, calls: [] };
globalThis.fetch = async (u, opt = {}) => {
  const url = new URL(u), m = opt.method || "GET", p = url.pathname.replace("/client/v4", "");
  cf.calls.push(m + " " + p);
  const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  if (opt.headers.Authorization !== "Bearer tok") return new Response(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }), { status: 403 });
  if (p === "/zones" && m === "GET") return ok(url.searchParams.get("name") === "aryanh.dev" ? [{ id: "Z1" }] : []);
  let mm;
  if (p === "/zones/Z1/custom_hostnames" && m === "POST") {
    const b = JSON.parse(opt.body);
    if (Object.values(cf.hostnames).some(h => h.hostname === b.hostname)) return new Response(JSON.stringify({ success: false, errors: [{ code: 1406, message: "Duplicate custom hostname found." }] }), { status: 409 });
    const id = "h" + ++cf.n; cf.hostnames[id] = { id, hostname: b.hostname, status: "pending", ssl: { status: "initializing", method: b.ssl.method } };
    return ok(cf.hostnames[id]);
  }
  if ((mm = p.match(/^\/zones\/Z1\/custom_hostnames\/(\w+)$/))) {
    const h = cf.hostnames[mm[1]];
    if (!h) return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
    if (m === "DELETE") { delete cf.hostnames[mm[1]]; return ok({ id: mm[1] }); }
    return ok(h);
  }
  if (p === "/zones/Z1/workers/routes" && m === "POST") {
    const b = JSON.parse(opt.body); const id = "r" + ++cf.n; cf.routes[id] = b; return ok({ id, ...b });
  }
  if ((mm = p.match(/^\/zones\/Z1\/workers\/routes\/(\w+)$/)) && m === "DELETE") { delete cf.routes[mm[1]]; return ok({ id: mm[1] }); }
  return new Response("{}", { status: 404 });
};

const off = { DB: db };
check("off without the token and target", !D.domainsEnabled(off) && !D.domainsEnabled({ DB: db, SAAS_TARGET: "saas.aryanh.dev" }));
check("no table yet: no domain, no crash", (await D.userTrackBase({ ...off, CF_API_TOKEN: "tok", SAAS_TARGET: "saas.aryanh.dev" }, 1)) === "");

const env = { DB: db, CF_API_TOKEN: "tok", SAAS_TARGET: "saas.aryanh.dev" };
check("finds the zone from the target", (await D.zoneId(env)) === "Z1");

let d = await D.setDomain(env, 1, "go.friend.com", R);
check("added as pending", d && d.hostname === "go.friend.com" && d.status === "pending", d);
check("registered with Cloudflare (http validation)", Object.values(cf.hostnames).some(h => h.hostname === "go.friend.com" && h.ssl.method === "http"));
check("routed to the worker", Object.values(cf.routes).some(r => r.pattern === "go.friend.com/*" && r.script === "mailspy"));
check("pending: emails keep the default", (await D.userTrackBase(env, 1)) === "");
check("pending: host isn't served as tracking yet", !(await D.isUserDomain(env, "go.friend.com")));

let msg = "";
try { await D.setDomain(env, 2, "go.friend.com", R); } catch (e) { msg = e.message; }
check("someone else can't take it", /already uses/.test(msg), msg);
try { await D.setDomain(env, 2, "saas.aryanh.dev", []); } catch (e) { msg = e.message; }
check("can't use the CNAME target", /belongs/.test(msg), msg);

// Cloudflare finishes
const hid = d.cf_id; cf.hostnames[hid].status = "active"; cf.hostnames[hid].ssl.status = "active";
sqlite.prepare("UPDATE track_domains SET checked_at=0").run();
await D.checkPendingDomains(env);
check("cron picks up the active state", (await D.userDomain(db, 1)).status === "active");
check("active: emails use it", (await D.userTrackBase(env, 1)) === "https://go.friend.com");
check("active: host is served as tracking", await D.isUserDomain(env, "go.friend.com"));
check("other hosts aren't", !(await D.isUserDomain(env, "evil.com")));

// switching to a different domain removes the old one at Cloudflare
d = await D.setDomain(env, 1, "links.friend.com", R);
check("switch: new one pending", d.hostname === "links.friend.com" && d.status === "pending");
check("switch: old hostname and route gone", !Object.values(cf.hostnames).some(h => h.hostname === "go.friend.com") && !Object.values(cf.routes).some(r => r.pattern === "go.friend.com/*"));
check("switch: old host no longer served", !(await D.isUserDomain(env, "go.friend.com")));

// Cloudflare loses it
delete cf.hostnames[d.cf_id];
const r2 = await D.refreshDomain(env, await D.userDomain(db, 1));
check("deleted at Cloudflare becomes an error", r2.status === "error", r2);

await D.removeDomain(env, 1);
check("removed: no row, no hostname, no route", !(await D.userDomain(db, 1)) && Object.keys(cf.hostnames).length === 0 && Object.keys(cf.routes).length === 0);

// route creation fails: the hostname is rolled back
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opt = {}) => (String(u).includes("/workers/routes") ? new Response(JSON.stringify({ success: false, errors: [{ message: "no permission" }] }), { status: 403 }) : realFetch(u, opt));
msg = "";
try { await D.setDomain(env, 1, "go.friend.com", R); } catch (e) { msg = e.message; }
check("route failure is reported", msg === "no permission", msg);
check("route failure leaves nothing behind", Object.keys(cf.hostnames).length === 0 && !(await D.userDomain(db, 1)));
globalThis.fetch = realFetch;

// ---- the Settings section
const cfg = { prefetchWindow: 12, spikeCount: 3, spikeWindow: 600, revivalDays: 7, followupHours: 48 };
const user = { id: 1, email: "me@x.com", name: "Me" };
const page = dom => V.settingsPage({ cfg, base: "https://mailspy.aryanh.dev", user, prefs: P.defaultPrefs(cfg), domain: dom });
check("hidden when off", !page(null).includes("Your tracking domain"));
check("form when none", page({ target: "saas.aryanh.dev", current: null, fallback: "go.aryanh.dev" }).includes('action="/settings/domain"'));
const pend = page({ target: "saas.aryanh.dev", current: { hostname: "go.friend.com", status: "pending" }, fallback: "go.aryanh.dev" });
check("pending shows the CNAME", pend.includes("CNAME") && pend.includes("saas.aryanh.dev") && pend.includes("Check now"));
const act = page({ target: "saas.aryanh.dev", current: { hostname: "go.friend.com", status: "active" }, fallback: "go.aryanh.dev" });
check("active shows working, no DNS steps", act.includes("Working") && !act.includes("CNAME"));

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
