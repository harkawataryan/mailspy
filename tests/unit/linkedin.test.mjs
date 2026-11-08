// LinkedIn people via a search API (cloudflare/src/finder.js), and the shared,
// quality-gated index that lets everyone reuse one search's results.
const SRC = new URL("../../cloudflare/src/", import.meta.url).href;
const F = await import(SRC + "finder.js");

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

const kv = new Map();
const env = { DOCS: {
  get: async (k, o) => { const v = kv.get(k); return v == null ? null : (o && o.type === "json" ? JSON.parse(v) : v); },
  put: async (k, v) => { kv.set(k, String(v)); },
} };
const idx = d => kv.has(`find:li:v2:${d}`) ? JSON.parse(kv.get(`find:li:v2:${d}`)) : null;

const prof = (name, title, co, snippet = "") => ({ title: `${name} - ${title} - ${co} | LinkedIn`, url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, "")}?trk=x`, content: snippet || `${title} at ${co}` });
const FIXTURES = {
  Stripe: [
    prof("Jane Doe", "Technical Recruiter", "Stripe"),
    { title: "Sam Lee – Stripe | LinkedIn", url: "https://www.linkedin.com/in/samlee", content: "Senior Talent Acquisition Partner at Stripe · Experience: Stripe" },
    { title: "Old Person - Recruiter - Acme | LinkedIn", url: "https://www.linkedin.com/in/old", content: "Ex-Stripe recruiter, now at Acme" },
    { title: "Pat Kim - Recruiter | LinkedIn", url: "https://www.linkedin.com/in/patkim", content: "Formerly at Stripe. Recruiter at Plaid." },
    { title: "Stripe | LinkedIn", url: "https://www.linkedin.com/company/stripe", content: "company page" },
  ],
  SpaceX: [
    prof("Ana Ruiz", "Recruiter", "SpaceX"), prof("Ben Cho", "Technical Sourcer", "SpaceX"),
    prof("Cara Diaz", "Talent Acquisition Partner", "SpaceX"), prof("Dev Shah", "University Recruiter", "SpaceX"),
  ],
  Quietco: [],
};
let calls = 0, lastBody = null, mode = "ok";
globalThis.fetch = async (url, opts = {}) => {
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (String(url).startsWith("https://api.tavily.com/")) {
    calls++;
    lastBody = JSON.parse(opts.body);
    if (mode === "bad") return J({ detail: "invalid" }, 401);
    const org = Object.keys(FIXTURES).find(o => lastBody.query.startsWith(o));
    return J({ results: FIXTURES[org] || [] });
  }
  return J({}, 404);
};
const KEY_A = "tvly-aaaaaaaaaaaaaaaaaaaaaaaaaa", KEY_B = "tvly-bbbbbbbbbbbbbbbbbbbbbbbbbb";

// --- reading search results
let r = await F.linkedinPeople(env, KEY_A, "Stripe", "stripe.com");
const names = r.list.map(p => p.name);
const jane = r.list.find(p => p.name === "Jane Doe");
check("current recruiters found, with titles and clean profile links", jane && jane.position === "Technical Recruiter" && jane.linkedin === "https://www.linkedin.com/in/janedoe", r.list);
check("title read from the snippet when the headline only names the company", r.list.find(p => p.name === "Sam Lee")?.position === "Senior Talent Acquisition Partner", r.list);
check("former employees left out (ex-, formerly)", !names.includes("Old Person") && !names.includes("Pat Kim"), names);
check("company pages ignored", r.list.length === 2, r.list);
check("search limited to LinkedIn", lastBody && lastBody.include_domains.includes("linkedin.com"), lastBody);
check("first search says where it came from", r.info && r.info.from === "search" && r.info.count === 2, r.info);

// --- a thin list is kept, but isn't "done"
check("thin list (2 recruiters) is saved to build on, marked not good", idx("stripe.com") && idx("stripe.com").good === false && idx("stripe.com").people.length === 2, idx("stripe.com"));
calls = 0;
r = await F.linkedinPeople(env, KEY_B, "Stripe", "stripe.com");
check("thin list: the next person with a key searches again", calls === 1 && r.info.from === "index+search", { calls, info: r.info });
r = await F.linkedinPeople(env, "", "Stripe", "stripe.com");
check("thin list: someone without a key still sees it, told a key finds more", r.list.length === 2 && r.info.from === "index" && r.info.canSearch === false && !r.info.good, r.info);

// --- a good list is shared: nobody pays for it again
calls = 0;
r = await F.linkedinPeople(env, KEY_A, "SpaceX", "spacex.com");
check("good list (4 recruiters) is indexed as good", calls === 1 && idx("spacex.com").good === true && r.info.good, idx("spacex.com"));
calls = 0;
r = await F.linkedinPeople(env, KEY_B, "SpaceX", "spacex.com");
check("another account searching SpaceX: from the index, no search credit used", calls === 0 && r.info.from === "index" && r.list.length === 4, { calls, info: r.info });
r = await F.linkedinPeople(env, "", "SpaceX", "spacex.com");
check("works without a key too", r.list.length === 4 && r.info.from === "index", r.info);
r = await F.linkedinPeople(env, KEY_B, "SpaceX", "spacex.com");
check("offers searching again to people with a key", r.info.canSearch === true, r.info);

// --- search again anyway
FIXTURES.SpaceX = [prof("Ana Ruiz", "Senior Recruiter", "SpaceX"), prof("Eli Park", "Recruiting Coordinator", "SpaceX")];
calls = 0;
r = await F.linkedinPeople(env, KEY_B, "SpaceX", "spacex.com", "both");
const ana = r.list.find(p => p.name === "Ana Ruiz");
check("both: searches, keeps the index's people and adds the new ones", calls === 1 && r.list.length === 5 && r.info.from === "index+search", { calls, n: r.list.length, info: r.info });
check("both: the newer title wins", ana && ana.position === "Senior Recruiter", ana);
r = await F.linkedinPeople(env, KEY_B, "SpaceX", "spacex.com", "fresh");
check("fresh: shows only the new search's people", r.list.length === 2 && r.info.from === "search", r.list.map(p => p.name));
check("fresh: still added to the shared index", idx("spacex.com").people.length === 5, idx("spacex.com").people.length);
r = await F.linkedinPeople(env, "", "SpaceX", "spacex.com", "both");
check("both without a key: the index, and a note to add a key", r.list.length === 5 && /search key/.test(r.error || ""), r);

// --- an old good list is searched again
const sx = idx("spacex.com"); sx.updated -= 100 * 86400; kv.set("find:li:v2:spacex.com", JSON.stringify(sx));
calls = 0;
r = await F.linkedinPeople(env, KEY_A, "SpaceX", "spacex.com");
check("good list older than 90 days: searched again", calls === 1 && r.info.from === "index+search", { calls, info: r.info });

// --- bad results are never indexed
calls = 0;
r = await F.linkedinPeople(env, KEY_A, "Quietco", "quietco.com");
check("no results: nothing stored", r.list.length === 0 && !kv.has("find:li:v2:quietco.com"), [...kv.keys()]);
r = await F.linkedinPeople(env, KEY_A, "Quietco", "quietco.com");
check("no results: the next search tries again", calls === 2, calls);
mode = "bad";
r = await F.linkedinPeople(env, "tvly-zzzzzzzzzzzzzzzzzzzzzzzzzz", "Figma", "figma.com");
check("bad key: clear message, nothing stored", /wasn't accepted/.test(r.error || "") && !kv.has("find:li:v2:figma.com"), r);
const before = kv.get("find:li:v2:stripe.com");
r = await F.linkedinPeople(env, "tvly-zzzzzzzzzzzzzzzzzzzzzzzzzz", "Stripe", "stripe.com", "both");
check("bad key with an index: shows the index plus the message, index untouched", r.list.length === 2 && r.error && kv.get("find:li:v2:stripe.com") === before, r);
mode = "ok";
r = await F.linkedinPeople(env, "", "Figma", "figma.com");
check("no key and no index: nothing searched", r.list.length === 0 && !r.error, r);

// --- quality rule and merging
const P = (name, position) => ({ name, position });
check("good: 3 recruiters", F.liGood([P("A B", "Recruiter"), P("C D", "Sourcer"), P("E F", "Talent Partner")]));
check("good: 5 people with a recruiter", F.liGood([P("A B", "Recruiter"), P("C D", "CEO"), P("E F", "CTO"), P("G H", "Engineer"), P("I J", "Designer")]));
check("not good: 4 people, 1 recruiter", !F.liGood([P("A B", "Recruiter"), P("C D", "CEO"), P("E F", "CTO"), P("G H", "Engineer")]));
check("not good: 6 people, no recruiters", !F.liGood([1, 2, 3, 4, 5, 6].map(i => P(`Person${i} Name`, "Engineer"))));
const now = 1_800_000_000;
const m = F.liMerge([{ name: "Old Gone", position: "Recruiter", seen: now - 400 * 86400 }, { name: "Kept One", position: "Recruiter", seen: now - 10 * 86400 }],
  [{ name: "New Person", position: "Engineer" }], now);
check("merge: people not seen for a year are dropped, recruiters listed first", m.map(p => p.name).join() === "Kept One,New Person", m);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
if (results.some(r => !r)) process.exit(1);
