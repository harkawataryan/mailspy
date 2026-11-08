// Email finder: a person's work email, or a company's recruiters.
//
// Without any key it does as much as free, public sources allow:
//   1. Company -> email domain: the official website from Wikidata, checked to
//      actually receive mail (MX lookup over DNS-over-HTTPS); falls back to
//      trying name.com / .io / .co / .ai / .org.
//   2. Real addresses at that domain, with names where available, from
//        - the company's own website (home, contact, about, careers, jobs,
//          security.txt),
//        - public PGP keys (keyserver.ubuntu.com),
//        - commits in the company's public GitHub repositories.
//   3. The company's address format, learned from those real examples
//      ("jane.doe", "jdoe", ...), used to rank the guesses for a person.
//   4. Gravatar: a guessed address with a Gravatar profile definitely exists.
// With a Hunter.io key (Settings) Hunter's results are added on top.
// Lookups are cached for 30 days (KV), so repeat searches are instant and free.

const HUNTER = "https://api.hunter.io/v2";
const CACHE_TTL = 30 * 86400;
const UA = "MailSpy/1.0 (personal email finder)";

// Most common work-address formats, most common first.
export const PATTERNS = [
  ["{first}.{last}", "first.last"],
  ["{first}", "first"],
  ["{f}{last}", "flast"],
  ["{first}{last}", "firstlast"],
  ["{f}.{last}", "f.last"],
  ["{first}_{last}", "first_last"],
  ["{first}{l}", "firstl"],
  ["{last}.{first}", "last.first"],
  ["{first}-{last}", "first-last"],
  ["{last}{f}", "lastf"],
  ["{last}", "last"],
];

const GENERIC_HIRING = ["careers", "jobs", "recruiting", "talent", "hr", "people"];
const HIRING_LOCAL_RE = /^(careers?|jobs?|recruit\w*|talent\w*|hiring|hr|people|join\w*|work\w*|apply|university|campus|internships?)$/i;
const RECRUITER_RE = /recruit|talent|sourc|hiring|people|human|\bhr\b|acquisition|campus|university/i;
const ROLE_LOCAL_RE = /^(info|hello|hi|contact|support|help|sales|press|media|pr|security|privacy|legal|abuse|admin|team|office|billing|partners?|marketing|noreply|no-reply|donotreply|webmaster|postmaster|careers?|jobs?|recruit\w*|talent\w*|hiring|hr|people|feedback|investors?|ir)$/i;
const COMPANYISH = /compan|corporat|business|firm|startup|bank|manufactur|retail|brand|software|platform|service|enterprise|conglomerate|agency|organi[sz]ation|employer|maker|developer|provider|chain|airline|insur|universit|lab|fund|consult|studio|publisher|network|technolog|store|group|holding/i;

const clean = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// "https://www.linkedin.com/in/jane-doe-1a2b3c4d/" -> "Jane Doe"; anything else is returned as it was.
export function nameFromInput(s) {
  const m = String(s || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return String(s || "");
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch {}
  return slug.toLowerCase().split("-").filter(p => p && !/\d/.test(p)).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function splitName(full) {
  const parts = String(full || "").replace(/\(.*?\)/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = clean(parts[0]), last = parts.length > 1 ? clean(parts[parts.length - 1]) : "";
  return first ? { first, last, display: parts.join(" ") } : null;
}

export function applyPattern(pattern, n) {
  if (/\{l(ast)?\}/.test(pattern) && !n.last) return "";
  return pattern.replace("{first}", n.first).replace("{last}", n.last)
    .replace("{f}", n.first[0] || "").replace("{l}", n.last[0] || "");
}

// "stripe.com", "https://www.stripe.com/jobs", "someone@stripe.com" -> "stripe.com"; anything else -> ""
export function asDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  if (s.includes("@")) s = s.split("@").pop();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[\/?#\s:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

const timeout = ms => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
async function get(url, opts = {}) {
  try {
    return await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: timeout(opts.ms || 5000) });
  } catch { return null; }
}

async function cached(env, key, fn) {
  if (env.DOCS) {
    const hit = await env.DOCS.get(key, { type: "json" }).catch(() => null);
    if (hit) return hit;
  }
  const val = await fn();
  if (env.DOCS && val) await env.DOCS.put(key, JSON.stringify(val), { expirationTtl: CACHE_TTL }).catch(() => {});
  return val;
}

// ------------------------------------------------------------------ domain
async function hasMx(domain) {
  const r = await get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    { headers: { Accept: "application/dns-json" }, ms: 4000 });
  if (!r || !r.ok) return false;
  const d = await r.json().catch(() => null);
  return !!(d && d.Status === 0 && Array.isArray(d.Answer) && d.Answer.some(a => a.type === 15));
}

// A website's domain that takes email: www.foo.co.uk -> foo.co.uk, careers.foo.com -> foo.com
async function mailDomain(host) {
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const d = labels.slice(i).join(".");
    if (labels.length - i < 2) break;
    if (/^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(d)) break;
    if (await hasMx(d)) return d;
  }
  return "";
}

async function wikidataSite(company) {
  const s = await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(company)}&language=en&type=item&limit=6&format=json`);
  const hits = s && s.ok ? ((await s.json().catch(() => ({}))).search || []) : [];
  if (!hits.length) return null;
  const ids = hits.map(h => h.id).filter(id => /^Q\d+$/.test(id));
  const q = `SELECT ?item ?site WHERE { VALUES ?item { ${ids.map(i => "wd:" + i).join(" ")} } ?item wdt:P856 ?site }`;
  const r = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
    { headers: { Accept: "application/sparql-results+json" }, ms: 6000 });
  const rows = r && r.ok ? ((await r.json().catch(() => ({}))).results || {}).bindings || [] : [];
  const site = {};
  for (const b of rows) {
    const id = b.item.value.split("/").pop();
    if (!site[id]) site[id] = b.site.value;
  }
  // companies first, then in search order
  // exact name + sounds like a company first ("Linear" the software company, not an asteroid survey)
  const q0 = String(company).trim().toLowerCase();
  // (a match only on an alias, like "LINEAR" for an asteroid survey, counts for less)
  const score = h => (String(h.label || "").toLowerCase() === q0 ? 2 : 0) + (COMPANYISH.test(h.description || "") ? 1 : 0)
    - (h.match && h.match.type === "alias" ? 1 : 0);
  const ordered = hits.slice().sort((a, b) => score(b) - score(a));
  for (const h of ordered) if (site[h.id] && score(h) > 0) return { url: site[h.id], label: h.label, description: h.description || "", id: h.id };
  return null;
}

function slugs(company) {
  const words = String(company || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/).filter(w => w && !/^(inc|llc|ltd|limited|corp|corporation|co|company|group|the|plc|gmbh|sa|ag)$/.test(w));
  if (!words.length) return [];
  return [...new Set([words.join(""), words.join("-"), words[0]])];
}

// Company name or website -> { domain, organization, how }
export async function resolveDomain(env, company) {
  const direct = asDomain(company);
  if (direct) {
    const d = (await mailDomain(direct)) || direct;
    return { domain: d, how: (await hasMx(d)) ? "given" : "given-nomx" };
  }
  const key = `find:dom:v3:${String(company).trim().toLowerCase().slice(0, 100)}`;
  return cached(env, key, async () => {
    const wd = await wikidataSite(company);
    if (wd) {
      const host = asDomain(wd.url);
      const d = host && (await mailDomain(host));
      if (d) {
        // remembered so templates can say "Stripe" for anyone @stripe.com
        if (env.DOCS && wd.label) await env.DOCS.put(`find:org:${d}`, wd.label, { expirationTtl: 365 * 86400 }).catch(() => {});
        return { domain: d, organization: wd.label, how: "wikidata", wid: wd.id };
      }
    }
    for (const x of slugs(company)) for (const tld of ["com", "io", "co", "ai", "org"]) {
      if (await hasMx(`${x}.${tld}`)) return { domain: `${x}.${tld}`, how: "guess" };
    }
    return { domain: "", how: "none" };
  });
}

// ------------------------------------------------------------------ evidence
function emailsIn(text, domain) {
  const t = text.replace(/&#0*64;|&#x0*40;|%40|\s*\[at\]\s*|\s*\(at\)\s*/gi, "@");
  const re = new RegExp(`[A-Za-z0-9._%+-]{1,64}@(?:[a-z0-9-]+\\.)*${domain.replace(/\./g, "\\.")}(?![a-z0-9.-]*[a-z0-9])`, "gi");
  return [...new Set((t.match(re) || []).map(e => e.toLowerCase().replace(/^[._%+-]+/, "")))].filter(e => !/^(u00|x22)/.test(e));
}

async function fromWebsite(domain) {
  const pages = ["", "contact", "about", "careers", "jobs", ".well-known/security.txt"];
  const found = [];
  await Promise.all(pages.map(async p => {
    const r = await get(`https://${domain}/${p}`, { ms: 5000 });
    if (!r || !r.ok) return;
    const type = r.headers.get("Content-Type") || "";
    if (!/text|html|json|xml/.test(type)) return;
    const text = (await r.text().catch(() => "")).slice(0, 200000);
    for (const e of emailsIn(text, domain)) found.push({ email: e, name: "", source: "website", where: `${domain}/${p}`.replace(/\/$/, "") });
  }));
  return found;
}

async function fromKeyserver(domain) {
  const r = await get(`https://keyserver.ubuntu.com/pks/lookup?search=${encodeURIComponent("@" + domain)}&op=index&options=mr`, { ms: 6000 });
  if (!r || !r.ok) return [];
  const out = [];
  for (const line of (await r.text().catch(() => "")).split("\n")) {
    if (!line.startsWith("uid:")) continue;
    let uid = line.split(":")[1] || "";
    try { uid = decodeURIComponent(uid); } catch {}
    const m = uid.match(/^(.*?)\s*<([^>]+)>/);
    const ts = Number(line.split(":")[2]) || 0;              // when the key was made
    if (m && m[2].toLowerCase().endsWith("@" + domain)) out.push({ email: m[2].toLowerCase(), name: m[1].trim(), source: "public key", ts });
  }
  return out.slice(0, 200);
}

async function fromGitHub(domain) {
  const org = domain.split(".")[0];
  const r = await get(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=10`, { headers: { Accept: "application/vnd.github+json" } });
  if (!r || !r.ok) return [];
  const repos = ((await r.json().catch(() => [])) || []).filter(x => x && !x.fork && !x.archived).slice(0, 2);
  const out = [];
  await Promise.all(repos.map(async repo => {
    const c = await get(`https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo.name)}/commits?per_page=60`,
      { headers: { Accept: "application/vnd.github+json" } });
    if (!c || !c.ok) return;
    for (const x of (await c.json().catch(() => [])) || []) {
      const a = x && x.commit && x.commit.author;
      if (a && a.email && a.email.toLowerCase().endsWith("@" + domain)) out.push({ email: a.email.toLowerCase(), name: a.name || "", source: "GitHub", ts: Date.parse(a.date) / 1000 || 0 });
    }
  }));
  return out;
}

// Real addresses at a domain, de-duplicated (cached 30 days per domain).
export async function evidenceFor(env, domain) {
  return cached(env, `find:ev:v2:${domain}`, async () => {
    const [site, keys, gh] = await Promise.all([fromWebsite(domain), fromKeyserver(domain), fromGitHub(domain)]);
    const by = new Map();
    for (const e of [...site, ...gh, ...keys]) {
      const prev = by.get(e.email);
      if (!prev) by.set(e.email, { ...e });
      else if (!prev.name && e.name) prev.name = e.name;
    }
    return { at: Date.now(), list: [...by.values()].slice(0, 300) };
  });
}

// Which format do this company's addresses follow? -> [{ pattern, label, votes }], best first, and how many named examples there were
export function inferPatterns(examples) {
  const votes = new Map();
  let named = 0;
  for (const e of examples) {
    const local = e.email.split("@")[0];
    if (ROLE_LOCAL_RE.test(local)) continue;
    const n = splitName(e.name);
    if (!n || !n.last || n.first === n.last) continue;
    let hit = false;
    for (const [p, label] of PATTERNS) {
      if (applyPattern(p, n) === local) { votes.set(p, { pattern: p, label, votes: (votes.get(p)?.votes || 0) + 1 }); hit = true; break; }
    }
    named++;
    if (!hit) votes.set("other", { pattern: "", label: "other", votes: (votes.get("other")?.votes || 0) + 1 });
  }
  return { ranked: [...votes.values()].filter(v => v.pattern).sort((a, b) => b.votes - a.votes), named };
}

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function hasGravatar(email) {
  const r = await get(`https://gravatar.com/avatar/${await sha256hex(email)}?d=404&s=1`, { ms: 4000 });
  return !!(r && r.status === 200);
}

function exampleOf(pattern, domain) {
  return `${applyPattern(pattern, { first: "jane", last: "doe" })}@${domain}`;
}

// ------------------------------------------------------------------ Hunter
async function hunter(env, key, endpoint, params) {
  const qs = new URLSearchParams({ ...params, api_key: key });
  const cacheKey = `find:v1:${endpoint}:${[...new URLSearchParams(params)].sort().map(p => p.join("=")).join("&").toLowerCase()}`;
  if (env.DOCS) {
    const hit = await env.DOCS.get(cacheKey, { type: "json" }).catch(() => null);
    if (hit) return { ...hit, cached: true };
  }
  const r = await get(`${HUNTER}/${endpoint}?${qs}`, { ms: 10000 });
  if (!r) return { error: "Couldn't reach Hunter." };
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = body.errors && body.errors[0] && (body.errors[0].details || body.errors[0].id);
    if (r.status === 401) return { error: "Your Hunter API key wasn't accepted. Check it in Settings." };
    if (r.status === 429 || r.status === 403) return { error: "Hunter says you've used this month's free searches." };
    if (r.status === 451) return { error: "Hunter won't look up this person (they've asked to be removed)." };
    return { error: detail ? `Hunter: ${detail}` : `Hunter error ${r.status}` };
  }
  const out = { data: body.data || {} };
  if (env.DOCS) await env.DOCS.put(cacheKey, JSON.stringify(out), { expirationTtl: CACHE_TTL }).catch(() => {});
  return out;
}

function domainNotes(out, res) {
  if (res.how === "guess") out.notes.push(`Assumed the company's email domain is ${res.domain}. If that's a different company, enter its website instead.`);
  if (res.how === "given-nomx") out.notes.push(`${res.domain} doesn't seem to receive email. Double-check the address.`);
}

// ------------------------------------------------------------------ searches
// Result: { mode, domain, organization, people: [{email,name,position,confidence,status,linkedin,source}],
//           guesses: [{email, format, badges: []}], pattern: {label, example, votes, named}, published: [...], notes: [], links: [] }
export async function findPerson(env, prefs, name, company) {
  const fromLink = /linkedin\.com\/in\//i.test(String(name || ""));
  name = nameFromInput(name);
  const n = splitName(name);
  if (!n) return { error: fromLink ? "Couldn't read a name from that LinkedIn link. Type their full name instead." : "Enter the person's name." };
  if (!String(company || "").trim()) return { error: "Enter the company name or website." };
  const out = { mode: "person", query: { name, company }, people: [], guesses: [], notes: [], published: [], links: [] };
  const domainIn = asDomain(company);

  if (prefs.hunter_key) {
    const params = { full_name: n.display };
    if (domainIn) params.domain = domainIn; else params.company = String(company).trim();
    const h = await hunter(env, prefs.hunter_key, "email-finder", params);
    if (h.error) out.notes.push(h.error);
    else {
      const d = h.data;
      out.cached = !!h.cached;
      out.domain = d.domain || domainIn; out.organization = d.company || "";
      if (d.email) out.people.push({
        email: d.email, name: [d.first_name, d.last_name].filter(Boolean).join(" ") || n.display,
        position: d.position || "", confidence: d.score ?? null,
        status: d.verification && d.verification.status || "", linkedin: d.linkedin_url || "", source: "Hunter",
      });
    }
  }
  if (!out.domain) {
    const res = await resolveDomain(env, company);
    out.domain = res.domain; out.organization = out.organization || res.organization || "";
    out.domainHow = res.how;
    if (!res.domain) { out.notes.push("Couldn't work out the company's email domain. Try its website instead, like stripe.com."); return out; }
    domainNotes(out, res);
  }

  // Real addresses at the company, and the format they follow
  const ev = await evidenceFor(env, out.domain);
  const { ranked, named } = inferPatterns(ev.list);
  if (ranked.length) {
    const top = ranked[0];
    out.pattern = { label: top.label, example: exampleOf(top.pattern, out.domain), votes: top.votes, named };
  }

  // The person themself among the real addresses?
  const seen = new Set(out.people.map(p => p.email));
  for (const e of ev.list) {
    const m = splitName(e.name);
    if (m && m.first === n.first && (!n.last || m.last === n.last) && !seen.has(e.email)) {
      out.people.push({ email: e.email, name: e.name, position: "", confidence: null, status: "", linkedin: "", source: e.where ? `their website` : e.source });
      seen.add(e.email);
    }
  }

  // ---- Guesses, best first ----
  // Score = what this company actually uses (real addresses found, and
  // deliveries learned from auto-try) + a prior for how common each format is.
  // Big, well-known companies mostly use first.last; small ones mostly first@.
  const big = out.domainHow === "wikidata" || named >= 5 || (!!prefs.hunter_key && out.people.some(p => p.source === "Hunter"));
  const PRIOR_BIG = { "{first}.{last}": 40, "{f}{last}": 18, "{first}": 14, "{first}{last}": 8, "{f}.{last}": 6, "{first}_{last}": 3, "{first}{l}": 3, "{last}.{first}": 2, "{first}-{last}": 2, "{last}{f}": 1, "{last}": 1 };
  const PRIOR_SMALL = { "{first}": 40, "{first}.{last}": 25, "{f}{last}": 12, "{first}{last}": 8, "{f}.{last}": 4, "{first}_{last}": 2, "{first}{l}": 3, "{last}.{first}": 1, "{first}-{last}": 1, "{last}{f}": 1, "{last}": 1 };
  const prior = big ? PRIOR_BIG : PRIOR_SMALL;
  let learned = {};
  if (env.DOCS) { try { learned = JSON.parse((await env.DOCS.get(`find:learn:${out.domain}`)) || "{}"); } catch {} }
  const votes = new Map(ranked.map(r => [r.pattern, r.votes]));
  const scoreOf = p => {
    let sc = prior[p] || 0;
    if (named >= 2) sc += 400 * ((votes.get(p) || 0) / named) + 5 * (votes.get(p) || 0);
    sc += 300 * (learned[p] || 0);
    return sc;
  };
  // Addresses at this company that belong to someone else (another Jane at jane@)
  const taken = new Map();
  for (const e of ev.list) {
    const m = splitName(e.name);
    if (m && !(m.first === n.first && (!n.last || m.last === n.last))) taken.set(e.email, e.name);
  }
  const order = PATTERNS.map(([p, label]) => ({ p, label, s: scoreOf(p) })).sort((a, b) => b.s - a.s);
  const cands = [];
  for (const { p, label, s } of order) {
    const local = applyPattern(p, n);
    if (!local) continue;
    const email = `${local}@${out.domain}`;
    if (seen.has(email) || taken.has(email) || cands.some(c => c.email === email)) continue;
    const badges = [];
    const v = votes.get(p), l = learned[p];
    if (l) badges.push(`format that got through here before`);
    if (v) badges.push(`format used by ${v} ${v === 1 ? "person" : "people"} here`);
    cands.push({ email, format: label, badges, score: Math.round(s) });
  }
  // What auto-try has already learned about these exact addresses
  const memory = env.DOCS ? await Promise.all(cands.slice(0, 10).map(c => env.DOCS.get(`find:addr:${c.email}`).catch(() => null))) : [];
  memory.forEach((m, i) => {
    if (m === "bad") cands[i].bad = true;
    if (m === "good") { cands[i].confirmed = true; cands[i].badges.unshift("confirmed: an email to it got through"); }
  });
  out.guesses = cands.filter(c => !c.bad).slice(0, 8);
  const dropped = cands.filter(c => c.bad).length;
  if (dropped) out.notes.push(`Left out ${dropped} address${dropped === 1 ? "" : "es"} that bounced before.`);

  // Gravatar: a guess with a profile is a real address
  const checks = await Promise.all(out.guesses.map(g => hasGravatar(g.email)));
  checks.forEach((ok, i) => { if (ok) { out.guesses[i].badges.unshift("confirmed: has a Gravatar"); out.guesses[i].confirmed = true; } });
  out.guesses.sort((a, b) => (b.confirmed === true) - (a.confirmed === true));   // stable: keeps the score order otherwise

  if (!out.people.length) {
    if (out.guesses.some(g => g.confirmed)) out.notes.push("The top address is confirmed to exist.");
    else if (out.pattern && out.pattern.votes >= 3) out.notes.push(`Ranked by the format this company uses (seen in ${out.pattern.votes} of ${out.pattern.named} real addresses). None is confirmed, so the top one is the best bet.`);
    else out.notes.push("Ranked by the formats companies use most. None is confirmed, so the top one is the best bet.");
  }
  return out;
}

// ------------------------------------------------------------------ people at a company
// "People at a company" lists real people (name + role), grouped as recruiting,
// leadership, engineering and others, from public sources:
//   * Hunter.io (if you added a key): names, titles and addresses,
//   * the company's own team / about / leadership pages,
//   * Wikidata: CEO, founders, chair,
//   * public GitHub commits and public keys: people with real addresses there.
// Click a person to see their address (known, or the likely ones for that
// company, with the same checks and auto-try as "Find a person").

const ROLE_RE = /\b(ceo|cto|coo|cfo|cpo|cmo|chief|co-?founder|founder|president|chair(?:man|woman|person)?|vp|vice president|head of|director|general manager|partner|engineer(?:ing)?|developer|designer|recruit(?:er|ing)?|talent|people|hr|operations|product|marketing|sales|counsel|scientist|researcher|lead|manager|founding)\b/i;
const RECRUIT_RE = /chief people|head of people|vp,? (?:of )?people|people officer|recruit|talent|sourc(?:er|ing)|people (?:ops|operations|partner|team)|\bhr\b|human resources|hiring|acquisition|campus|university|people & culture/i;
const LEAD_RE = /\b(ceo|cto|coo|cfo|cpo|cmo|chief|co-?founder|founder|founding|president|chair|vp|vice president|head of|director|general manager|partner)\b/i;
const ENG_RE = /engineer|developer|software|\bswe\b|\bsre\b|devops|scientist|research|machine learning|\bml\b|\bdata\b|infrastructure|security/i;
const NOT_STAFF_RE = /\b(former|investor|advisor|adviser|angel|board of directors|board member|backed by|investors?)\b/i;
const NAME_RE = /^[A-Z][a-zA-Z'’.-]+(?: [A-Z][a-zA-Z'’.-]+){1,3}$/;
const NAME_STOP = /\b(web|apps?|sites?|marketing|sales|engineering|sdks?|release|signing|bot|robot|automation|ci|noreply|design|designs|product|products|brand|guidelines|explore|try|socials?|stack|team|teams|careers?|about|company|contact|privacy|terms|blog|news|press|pricing|docs|login|sign|enterprise|customers?|platform|solutions?|resources|community|events?|jobs?|learn|support|help|security|status|developers?|partners?|investors?|leadership|culture|values|mission|story|policy|cookies?|settings|home|menu|search|download|demo|features?|integrations?|changelog|roadmap|templates?|guide|guides|academy|webinars?|podcast|reports?|case|studies|careers|open|roles|apply|meet|our|the|and|for|with|your|all|more|view|read|see|watch|get|start|free|trial|pricing)\b/i;

function textLines(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/span|\/a|\/td|\/dt|\/dd|\/figcaption|\/strong|\/b)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&[a-z]+;|&#\d+;/g, " ")
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function looksLikeName(s, org) {
  if (!NAME_RE.test(s) || NAME_STOP.test(s)) return false;
  if (org && s.toLowerCase().includes(org.toLowerCase().split(/\s+/)[0])) return false;   // "Figma Design"
  return true;
}
const DEPT_WORDS = /^(engineering|sales|marketing|product|products|design|operations|security|people|talent|recruiting|finance|legal|growth|partnerships|research|data|infrastructure|platform|customer|customers|success|support|brand|communications|policy|ai|ml|hr|it|go|to|market|business|development|strategy|technology|revenue|community|content|creative|culture|experience|global|international|north|america|europe|emea|apac|us|uk|senior|staff|principal|lead|chief|officer|executive|vice|president|head|director|manager|founder|co-founder|cofounder|founding|ceo|cto|coo|cfo|cpo|cmo|ciso|vp|svp|evp|chair|chairman|chairwoman|board|science|compute|architect|interpretability|public|benefit|general|counsel|co|in|residence|and|of|the|at|for|&)$/i;
// A title has to name a role a person holds, not just a department ("Product").
const ROLE_NOUN_RE = /\b(ceo|cto|coo|cfo|cpo|cmo|ciso|chief|co-?founder|founder|founding|president|chair(?:man|woman|person)?|vp|svp|evp|vice president|head|director|manager|partner|engineer|developer|designer|recruiter|recruiting|sourcer|lead|officer|scientist|researcher|counsel|architect|analyst|specialist|coordinator|generalist|advocate|associate)\b/i;
function looksLikeTitle(s, org) {
  if (!s || s.length > 70 || !ROLE_RE.test(s) || !ROLE_NOUN_RE.test(s) || NOT_STAFF_RE.test(s)) return false;
  // A title naming another company is a quote or an investor ("CEO of Squarespace",
  // "Sentry co-founder", "Design Director, Code and Theory"), not someone who works here.
  const orgWords = String(org || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const other = s.split(/[\s,/|·•()&.-]+/).filter(w => /^[A-Z]/.test(w) && !DEPT_WORDS.test(w) && !orgWords.includes(w.toLowerCase()));
  return other.length === 0;
}

// Names and titles from a team / about page: structured data first, then "Name / Title" lines.
export function peopleFromPage(html, org) {
  const out = [];
  const seen = new Set();
  const add = (name, title, how) => {
    const k = name.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push({ name, position: title, how });
  };
  for (const m of html.matchAll(/"@type"\s*:\s*"Person"[^{}]*?"name"\s*:\s*"([^"]{3,60})"(?:[^{}]*?"jobTitle"\s*:\s*"([^"]{2,80})")?/g)) {
    if (looksLikeName(m[1], org) && (!m[2] || looksLikeTitle(m[2], org))) add(m[1], m[2] || "", "structured");
  }
  const L = textLines(html);
  for (let i = 0; i < L.length - 1; i++) {                    // "Jane Doe" then "Head of Talent"
    if (looksLikeName(L[i], org) && looksLikeTitle(L[i + 1], org)) add(L[i], L[i + 1], "page");
  }
  if (out.length < 2) {
    for (let i = 0; i < L.length - 1; i++) {                  // some pages put the title first
      if (looksLikeTitle(L[i], org) && looksLikeName(L[i + 1], org) && L[i].split(" ").length <= 6) add(L[i + 1], L[i], "page");
    }
  }
  return out.slice(0, 40);
}

async function fromTeamPages(env, domain, org) {
  return cached(env, `find:team:v1:${domain}`, async () => {
    const paths = ["about", "team", "company", "about-us", "leadership", "people", "about/team", "company/leadership"];
    const found = [];
    await Promise.all(paths.map(async p => {
      const r = await get(`https://${domain}/${p}`, { ms: 6000, headers: { "User-Agent": "Mozilla/5.0 (compatible; MailSpy/1.0)" } });
      if (!r || !r.ok || !/html/.test(r.headers.get("Content-Type") || "")) return;
      const html = (await r.text().catch(() => "")).slice(0, 600000);
      for (const x of peopleFromPage(html, org)) found.push({ ...x, where: `${domain}/${p}` });
    }));
    const by = new Map();
    for (const x of found) if (!by.has(x.name.toLowerCase()) || (!by.get(x.name.toLowerCase()).position && x.position)) by.set(x.name.toLowerCase(), x);
    return { list: [...by.values()].slice(0, 40) };
  });
}

// Wikidata item for a company given only its website (spacex.com -> Q193701)
async function wikidataForDomain(domain) {
  const label = domain.split(".")[0];
  const s = await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(label)}&language=en&type=item&limit=6&format=json`);
  const hits = s && s.ok ? ((await s.json().catch(() => ({}))).search || []) : [];
  const ids = hits.map(h => h.id).filter(id => /^Q\d+$/.test(id));
  if (!ids.length) return null;
  const q = `SELECT ?item ?site WHERE { VALUES ?item { ${ids.map(i => "wd:" + i).join(" ")} } ?item wdt:P856 ?site }`;
  const r = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json" }, ms: 6000 });
  const rows = r && r.ok ? ((await r.json().catch(() => ({}))).results || {}).bindings || [] : [];
  for (const b of rows) {
    const host = asDomain(b.site.value);
    if (host && (host === domain || host.endsWith("." + domain))) {
      const id = b.item.value.split("/").pop();
      return { id, label: (hits.find(h => h.id === id) || {}).label || "" };
    }
  }
  return null;
}

// CEO, founders and chair from Wikidata (current ones; founders are founders)
async function wikidataPeople(env, wid) {
  if (!wid) return [];
  return (await cached(env, `find:wdp:v1:${wid}`, async () => {
    const q = `SELECT ?p ?pLabel ?prop WHERE {
      VALUES ?prop { p:P169 p:P112 p:P488 p:P1037 }
      wd:${wid} ?prop ?st . ?st ?ps ?p . ?psProp wikibase:claim ?prop ; wikibase:statementProperty ?ps .
      FILTER NOT EXISTS { ?st pq:P582 ?end }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
    const r = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json" }, ms: 7000 });
    const rows = r && r.ok ? ((await r.json().catch(() => ({}))).results || {}).bindings || [] : [];
    const ROLE = { P169: "CEO", P112: "Founder", P488: "Chair", P1037: "Director" };
    const by = new Map();
    for (const b of rows) {
      const name = b.pLabel && b.pLabel.value;
      if (!name || /^Q\d+$/.test(name)) continue;
      const role = ROLE[b.prop.value.split("/").pop()];
      const prev = by.get(name);
      by.set(name, prev ? (prev.includes(role) ? prev : prev + ", " + role) : role);
    }
    return { list: [...by.entries()].map(([name, position]) => ({ name, position })) };
  })).list;
}

const keyOf = name => (splitName(name) || {}).first + " " + (splitName(name) || {}).last;

export async function findPeople(env, prefs, company) {
  if (!String(company || "").trim()) return { error: "Enter the company name or website." };
  const out = { mode: "recruiters", query: { company }, people: [], groups: [], guesses: [], notes: [], published: [], links: [] };
  const domainIn = asDomain(company);
  const all = [];          // { name, position, email, source, group }

  if (prefs.hunter_key) {
    const params = { limit: "10" };
    if (domainIn) params.domain = domainIn; else params.company = String(company).trim();
    const h = await hunter(env, prefs.hunter_key, "domain-search", params);
    if (h.error) out.notes.push(h.error);
    else {
      const d = h.data;
      out.cached = !!h.cached;
      out.domain = d.domain || domainIn; out.organization = d.organization || "";
      for (const e of d.emails || []) {
        const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
        if (name) all.push({ name, position: e.position || "", email: e.value, emailNote: e.confidence != null ? `${e.confidence}% (Hunter)` : "Hunter", source: "Hunter", linkedin: e.linkedin || "" });
      }
    }
  }
  let wid = null;
  if (!out.domain) {
    const res = await resolveDomain(env, company);
    out.domain = res.domain; out.organization = out.organization || res.organization || "";
    wid = res.wid || null;
    if (!res.domain) { out.notes.push("Couldn't work out the company's email domain. Try its website instead, like stripe.com."); return out; }
    domainNotes(out, res);
  }
  if (!wid) {
    const w = await cached(env, `find:wid:v1:${out.domain}`, async () => (await wikidataForDomain(out.domain)) || { id: "" });
    wid = w && w.id || null;
    if (!out.organization && w && w.label) out.organization = w.label;
  }
  const label0 = out.domain.split(".")[0];
  const org = out.organization || (label0.charAt(0).toUpperCase() + label0.slice(1));
  if (!out.organization) out.organization = org;

  const [ev, team, wd] = await Promise.all([evidenceFor(env, out.domain), fromTeamPages(env, out.domain, org), wikidataPeople(env, wid)]);
  for (const p of team.list) all.push({ name: p.name, position: p.position, source: "their website", where: p.where });
  for (const p of wd) all.push({ name: p.name, position: p.position, source: "Wikidata" });
  const recent = Date.now() / 1000 - 5 * 365 * 86400;           // addresses older than ~5 years are often gone
  for (let e of ev.list) {
    if (!e.name || e.source === "website" || (e.ts && e.ts < recent)) continue;
    const clean = e.name.replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!looksLikeName(clean, org)) continue;                  // "Anthropic SDKs", "Release Signing", handles
    e = { ...e, name: clean };
    const n = splitName(e.name);
    if (!n || !n.last || n.first === n.last) continue;          // logins and handles aren't names
    all.push({ name: e.name, position: e.source === "GitHub" ? "Engineering (public code)" : "", email: e.email,
      emailNote: e.source === "GitHub" ? "used in their public code" : "on their public key", source: e.source });
  }

  // one entry per person, keeping the best title and any known address
  const by = new Map();
  for (const p of all) {
    const k = keyOf(p.name);
    if (!k.trim()) continue;
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...p }); continue; }
    if (!prev.email && p.email) { prev.email = p.email; prev.emailNote = p.emailNote; }
    if ((!prev.position || /public code/.test(prev.position)) && p.position) prev.position = p.position;
    if (p.linkedin && !prev.linkedin) prev.linkedin = p.linkedin;
  }
  const people = [...by.values()];
  const groupOf = p => RECRUIT_RE.test(p.position) ? "recruiting" : LEAD_RE.test(p.position) ? "leadership"
    : (ENG_RE.test(p.position) || p.source === "GitHub") ? "engineering" : "others";
  const rankLead = p => /\bceo\b/i.test(p.position) ? 0 : /founder/i.test(p.position) ? 1 : /\b(cto|coo|cfo|cpo|chief)\b/i.test(p.position) ? 2 : /president|chair/i.test(p.position) ? 3 : /\bvp\b|vice president|head of/i.test(p.position) ? 4 : 5;
  const GROUPS = [
    ["recruiting", "Recruiting & HR"],
    ["leadership", "Leadership"],
    ["engineering", "Engineering"],
    ["others", "Other people"],
  ];
  for (const [key, label] of GROUPS) {
    let list = people.filter(p => groupOf(p) === key);
    if (key === "leadership") list.sort((a, b) => rankLead(a) - rankLead(b));
    else list.sort((a, b) => (!!b.email - !!a.email) || (!!b.position - !!a.position));
    if (list.length) out.groups.push({ key, label, people: list.slice(0, key === "engineering" || key === "others" ? 6 : 10) });
  }

  // addresses the company publishes, and the usual hiring inboxes (shown last, folded away)
  const site = ev.list.filter(e => e.source === "website");
  const hiring = site.filter(e => HIRING_LOCAL_RE.test(e.email.split("@")[0]));
  out.published = [...hiring, ...site.filter(e => !hiring.includes(e))].slice(0, 8)
    .map(e => ({ email: e.email, where: e.where, hiring: hiring.includes(e) }));
  const listed = new Set(out.published.map(p => p.email));
  out.guesses = GENERIC_HIRING.map(l => `${l}@${out.domain}`).filter(e => !listed.has(e)).map(email => ({ email, format: "shared inbox", badges: [] }));
  const { ranked, named } = inferPatterns(ev.list);
  if (ranked.length) out.pattern = { label: ranked[0].label, example: exampleOf(ranked[0].pattern, out.domain), votes: ranked[0].votes, named };

  out.links.push({ label: "Recruiters on LinkedIn", href: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${org} recruiter`)}` });
  out.links.push({ label: "Talent team on LinkedIn", href: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${org} talent acquisition`)}` });
  const hasRecruiters = out.groups.some(g => g.key === "recruiting");
  if (!out.groups.length) out.notes.push(`Couldn't find people at ${org} in public sources. Find one on LinkedIn (links below), then use "A person" with their name.`);
  else if (!hasRecruiters) out.notes.push(`No recruiters listed publicly, so here are other people at ${org}. Founders and engineering leads often pass emails on, or find a recruiter on LinkedIn (links below).`);
  return out;
}

// older name, still used by the routes
export const findRecruiters = findPeople;
