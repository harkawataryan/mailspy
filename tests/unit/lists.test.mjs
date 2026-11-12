// Dashboard search/filters and CSV (cloudflare/src/lists.js) on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const L = await import(new URL("../../cloudflare/src/lists.js", import.meta.url).href);

let results = [];
const check = (n, c, d) => { results.push(!!c); console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  [" + JSON.stringify(d) + "]")); };

function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.all())) };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8"));
const db = d1(sqlite);
const t = Date.now() / 1000, DAY = 86400;
const add = (uid, to, name, subject, extra = {}) => {
  const e = { created_at: t, opens: 0, clicks: 0, scheduled_at: null, ...extra };
  sqlite.prepare("INSERT INTO emails(token,to_addr,to_name,subject,created_at,opens,clicks,scheduled_at,user_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(Math.random().toString(36), to, name, subject, e.created_at, e.opens, e.clicks, e.scheduled_at, uid);
};
add(1, "jane@stripe.com", "Jane Doe", "Intro call", { opens: 2, clicks: 1 });
add(1, "bob@figma.com", "Bob", "Following up", { created_at: t - 20 * DAY });
add(1, "kim@acme.example", null, "100% match_here", { created_at: t - 60 * DAY, opens: 1 });
add(1, "later@x.example", "Later", "Scheduled one", { scheduled_at: t + DAY });
add(2, "jane@stripe.com", "Jane Doe", "Someone else's", { opens: 5 });

const F = (o = {}) => ({ q: "", status: "", days: "", sort: "", page: 1, ...o });
const subjects = async f => (await L.emailListPage(db, 1, f)).emails.map(e => e.subject);
const p = s => new URLSearchParams(s);

check("filters read from the URL", JSON.stringify(L.readFilters(p("q=%20a%20%20b&status=opened&days=30&page=3"))) === JSON.stringify({ q: "a b", status: "opened", days: "30", sort: "", page: 3 }));
check("unknown filter values ignored", JSON.stringify(L.readFilters(p("status=nope&days=5&page=-2"))) === JSON.stringify(F()));
check("query string round trip, page resets", L.filterQuery(F({ q: "a&b", status: "opened", page: 4 })) === "?q=a%26b&status=opened"
  && L.filterQuery(F({ page: 4 }), { page: 2 }) === "?page=2" && L.filterQuery(F()) === "");

check("no filter: only my emails", (await L.emailListPage(db, 1, F())).matched === 4);
check("search by company domain", JSON.stringify(await subjects(F({ q: "stripe" }))) === '["Intro call"]');
check("search by name, case-insensitive", JSON.stringify(await subjects(F({ q: "JANE" }))) === '["Intro call"]');
check("search by subject", JSON.stringify(await subjects(F({ q: "following" }))) === '["Following up"]');
check("every word must match", (await subjects(F({ q: "jane figma" }))).length === 0 && (await subjects(F({ q: "bob figma" }))).length === 1);
check("% and _ are literal", JSON.stringify(await subjects(F({ q: "100%" }))) === '["100% match_here"]' && (await subjects(F({ q: "_" }))).length === 1);
check("status opened", JSON.stringify(await subjects(F({ status: "opened" }))) === '["Intro call","100% match_here"]');
check("status not opened leaves out scheduled", JSON.stringify(await subjects(F({ status: "unopened" }))) === '["Following up"]');
check("status clicked", JSON.stringify(await subjects(F({ status: "clicked" }))) === '["Intro call"]');
check("status scheduled", JSON.stringify(await subjects(F({ status: "scheduled" }))) === '["Scheduled one"]');
check("last 7 days", (await subjects(F({ days: "7" }))).length === 2);
check("last 30 / 90 days", (await subjects(F({ days: "30" }))).length === 3 && (await subjects(F({ days: "90" }))).length === 4);
check("filters combine", JSON.stringify(await subjects(F({ status: "opened", days: "30" }))) === '["Intro call"]');
for (let i = 0; i < 230; i++) add(1, `p${i}@bulk.example`, null, `Bulk ${i}`);
// sorting: latest activity by default (sent, real open, real click, reply)
{
  const ids = {};
  for (const [k, ago, extra] of [["old-but-opened", 30, { opens: 1 }], ["new-quiet", 1, {}], ["old-quiet", 40, {}]]) {
    add(9, k + "@s.example", null, k, { created_at: t - ago * DAY, ...extra });
    ids[k] = sqlite.prepare("SELECT id FROM emails WHERE subject=?").get(k).id;
  }
  sqlite.prepare("UPDATE emails SET last_open=? WHERE id=?").run(t - 60, ids["old-but-opened"]);
  sqlite.prepare("UPDATE emails SET replied_at=? WHERE id=?").run(t - 30, ids["old-quiet"]);
  const sub9 = async f => (await L.emailListPage(db, 9, f)).emails.map(e => e.subject);
  check("default sort: latest activity first (reply, then open, then newest send)",
    JSON.stringify(await sub9(F())) === JSON.stringify(["old-quiet", "old-but-opened", "new-quiet"]), await sub9(F()));
  check("sort: newest sent", JSON.stringify(await sub9(F({ sort: "sent" }))) === JSON.stringify(["new-quiet", "old-but-opened", "old-quiet"]), await sub9(F({ sort: "sent" })));
  check("sort: oldest sent", (await sub9(F({ sort: "oldest" })))[0] === "old-quiet", "");
  check("sort: most opens", (await sub9(F({ sort: "opens" })))[0] === "old-but-opened", "");
  check("sort read from the URL and kept in links", L.readFilters(p("sort=opens")).sort === "opens" && L.readFilters(p("sort=bogus")).sort === ""
    && L.filterQuery(F({ sort: "clicks", status: "opened" }), { status: "" }) === "?sort=clicks", "");
}
const pg1 = await L.emailListPage(db, 1, F({ q: "bulk" })), pg3 = await L.emailListPage(db, 1, F({ q: "bulk", page: 3 }));
check("pages", pg1.matched === 230 && pg1.emails.length === L.PAGE_SIZE && pg3.emails.length === 30 && pg3.emails[29].subject === "Bulk 0");

check("csv: plain cell", L.csvCell("hello") === "hello" && L.csvCell(3) === "3" && L.csvCell(null) === "");
check("csv: quotes, commas, newlines", L.csvCell('a "b", c') === '"a ""b"", c"' && L.csvCell("x\ny") === '"x\ny"' && L.csvCell("x\r\ny") === '"x\r\ny"');
check("csv: formula injection guarded", ["=1+1", "+1", "-1", "@SUM(A1)", "\tx"].every(v => L.csvCell(v).startsWith("'") || L.csvCell(v).startsWith("\"'")));
check("csv: guarded and quoted together", L.csvCell('=HYPERLINK("http://x","y")') === '"\'=HYPERLINK(""http://x"",""y"")"');
check("csv: numbers untouched", L.csvCell(-1) === "-1");
const csv = L.toCsv(["a", "b"], [["1", "é😀"]]);
check("csv: BOM and CRLF", csv === "﻿a,b\r\n1,é😀\r\n", csv);
const res = await L.emailsCsv(db, 1, F({ q: "stripe" }));
const text = await res.text();
check("emails csv: headers", res.headers.get("Content-Type") === "text/csv; charset=utf-8"
  && /^attachment; filename="mailspy-emails-\d{4}-\d\d-\d\d\.csv"$/.test(res.headers.get("Content-Disposition")), [...res.headers]);
check("emails csv: my matching row only", text.split("\r\n").length === 3 && text.includes("jane@stripe.com,Jane Doe,Intro call,Opened,2,1") && !text.includes("Someone else"), text);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
