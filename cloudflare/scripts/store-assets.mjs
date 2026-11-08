// Renders the Chrome Web Store images from the real dashboard templates, with
// made-up sample data (example.com addresses, fictional people).
//
//   dist/store/screenshot-1-dashboard.png    1280x800  designed listing images
//   dist/store/screenshot-2-timeline.png
//   dist/store/screenshot-3-notifications.png
//   dist/store/screenshot-4-scheduled.png
//   dist/store/screenshot-5-real-opens.png
//   dist/store/promo-small-440x280.png       440x280
//
//   npm run store-assets            (needs Google Chrome or Microsoft Edge installed)

import { writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as views from "../src/views.js";
import { markSVG } from "../../brand/mark.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "dist", "store");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.startsWith("screenshot-")) rmSync(join(out, f));

const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find(p => existsSync(p));
if (!browser) { console.error("Install Google Chrome or Microsoft Edge to render the images."); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "mailspy-store-"));
function render(name, doc, w, h, scale = 1, dir = work, transparent = false) {
  const page = join(work, name + ".html");
  writeFileSync(page, doc);
  const png = join(dir, name + ".png");
  spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${join(work, "profile")}`, `--force-device-scale-factor=${scale}`,
    "--blink-settings=preferredColorScheme=1", `--window-size=${w},${h}`, `--screenshot=${png}`,
    "--virtual-time-budget=2000", ...(transparent ? ["--default-background-color=00000000"] : []), pathToFileURL(page).href,
  ], { stdio: "pipe", timeout: 90000 });
  if (!existsSync(png)) throw new Error("render failed: " + name);
  return png;
}
const fileUrl = p => pathToFileURL(p).href;

// ---------------------------------------------------------------- sample data
const T = Date.now() / 1000, min = 60, hr = 3600, day = 86400;
const user = { id: 1, email: "you@example.com", name: "Alex Rivera", is_admin: 0 };
const cfg = { extensionUrl: "", prefetchWindow: 12, spikeCount: 3, spikeWindow: 600, revivalDays: 7, followupHours: 48 };
const people = [
  ["Jordan Lee", "jordan@northwind.example"], ["Priya Shah", "priya@contoso.example"],
  ["Marcus Chen", "marcus@fabrikam.example"], ["Sofia Alvarez", "sofia@tailspin.example"],
  ["Daniel Okafor", "daniel@adventure.example"], ["Hana Kim", "hana@litware.example"],
  ["Ethan Brooks", "ethan@proseware.example"],
];
const subjects = [
  "Following up on our call", "Proposal for Q3 partnership", "Quick question about the role",
  "Portfolio and resume attached", "Coffee next week?", "Re: Product demo recap", "Thanks for your time today",
];
const mkEmail = (i, extra = {}) => ({
  id: i + 1, to_name: people[i][0], to_addr: people[i][1], subject: subjects[i],
  created_at: T - (i * 7 + 2) * hr, scheduled_at: null, opens: 0, clicks: 0, last_open: null, ...extra,
});
const emails = [
  mkEmail(0, { opens: 3, clicks: 1, last_open: T - 4 * min }),
  mkEmail(1, { opens: 1, last_open: T - 2 * hr }),
  mkEmail(2),
  mkEmail(3, { scheduled_at: T + 15 * hr }),
  mkEmail(4, { opens: 5, clicks: 2, last_open: T - 25 * min }),
  mkEmail(5, { opens: 2, clicks: 1, last_open: T - 6 * hr }),
  mkEmail(6),
];
const act = (kind, ago, geo, i, flagged = null) => ({ id: 0, kind, ts: T - ago, geo, flagged,
  email_id: i + 1, to_addr: people[i][1], to_name: people[i][0], subject: subjects[i] });
const activity = [
  act("open", 4 * min, "Austin, US", 0), act("click", 9 * min, "Austin, US", 0),
  act("open", 25 * min, "Toronto, CA", 4), act("open", 31 * min, "Toronto, CA", 4),
  act("click", 33 * min, "Toronto, CA", 4), act("open", 2 * hr, "London, GB", 1),
  act("open", 6 * hr, "Seattle, US", 5),
];
const reminders = [
  { id: 9, email_id: 3, kind: "followup", ts: T - hr, message: `No open yet: "${subjects[2]}" to ${people[2][0]} after 48h. Time to follow up.` },
  { id: 8, email_id: 5, kind: "spike", ts: T - 30 * min, message: `Open spike: ${people[4][0]} opened "${subjects[4]}" 3x in 10 min` },
];
const totals = { total: 24, opened: 17, opens: 58, clicks: 21 };
const ev = (kind, ago, ua, geo, ip, flagged = null, url = null) =>
  ({ kind, ts: T - ago, user_agent: ua, geo, ip, is_bot: flagged ? 1 : 0, flagged, url });
const GMAIL = "Mozilla/5.0 (via ggpht.com GoogleImageProxy)";

// Hide everything on a page except one card, enlarged, for close-up shots.
const focus = (doc, css) => doc.replace("</head>", `<style>
  html,body{background:transparent!important}
  header.top,.page-head,.welcome{display:none!important}
  main{max-width:none;padding:60px 64px 90px}
  .card{box-shadow:0 28px 70px rgba(15,23,42,.20),0 2px 8px rgba(15,23,42,.08)!important;border-radius:16px!important}
  ${css}</style></head>`);

// ---------------------------------------------------------------- raw views (2x)
const raw = {};
raw.dashboard = render("raw-dashboard", views.dashboard({ user, cfg, welcome: false, emails, totals, activity, reminders, maxAlert: 0, week: { sent: 7 } }), 1280, 800, 2);

raw.email = render("raw-email", views.emailPage({
  user, base: "https://mailspy.example", maxAlert: 0, email: emails[0],
  links: [{ url: "https://calendar.example.com/book/alex", clicks: 1, token: "x" }, { url: "https://alexrivera.example/portfolio", clicks: 0, token: "y" }],
  events: [
    ev("open", 4 * min, GMAIL, "Austin, US", "66.249.84.10"),
    ev("click", 9 * min, "Mozilla/5.0 (Macintosh)", "Austin, US", "203.0.113.24", null, "https://calendar.example.com/book/alex"),
    ev("open", 11 * min, "Mozilla/5.0 (iPhone)", "Austin, US", "203.0.113.24"),
    ev("open", 3 * hr, GMAIL, "Austin, US", "66.249.84.12"),
  ],
}), 1280, 800, 2);

const scheduledEmails = [
  mkEmail(3, { scheduled_at: T + 15 * hr }),
  { ...mkEmail(6), scheduled_at: T + 2 * day + 3 * hr, subject: "Checking in before Friday" },
  { ...mkEmail(1), scheduled_at: T + 4 * day, subject: "Q3 proposal: next steps" },
  mkEmail(0, { opens: 3, clicks: 1, last_open: T - 4 * min }),
  mkEmail(4, { opens: 5, clicks: 2, last_open: T - 25 * min }),
  mkEmail(2),
];
raw.scheduled = render("raw-scheduled", focus(
  views.dashboard({ user, cfg, welcome: false, emails: scheduledEmails, totals, activity: [], reminders: [], maxAlert: 0, week: {} }),
  `.stats,.grid>.card:first-child{display:none!important} .grid{grid-template-columns:1fr!important}
   .cell-main .s,.cell-main .r{max-width:300px}`), 860, 700, 2, work, true);

raw.filtered = render("raw-filtered", focus(views.emailPage({
  user, base: "https://mailspy.example", maxAlert: 0, email: { ...emails[1], opens: 1 },
  links: [],
  events: [
    ev("open", 2 * hr, GMAIL, "London, GB", "66.249.84.31"),
    ev("open", 5 * hr, "Mozilla/5.0 (Windows NT 10.0)", "", "198.51.100.7", "self"),
    ev("click", 7 * hr, "Mozilla/5.0 Microsoft SafeLinks", "Dublin, IE", "40.94.1.2", "scanner", "https://contoso.example/q3"),
    ev("open", 7 * hr + 30, "Mozilla/5.0 (Macintosh) AppleWebKit", "", "17.58.1.1", "prefetch"),
  ],
}), `.stats,.grid>.card:first-child,main>p,main>.card:first-of-type{display:none!important}
    .grid{grid-template-columns:1fr!important} main{zoom:1.12}`), 780, 660, 2, work, true);

// ---------------------------------------------------------------- popup + notification mock
const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0d9488", "#4f46e5", "#15803d", "#b45309"];
const av = (name, c) => `<span class="av" style="background:${c}">${name.split(" ").map(w => w[0]).join("")}</span>`;
const popupItems = [
  ["Jordan Lee", "opened your email", "Following up on our call · 4m ago · Austin, US", "#16a34a", COLORS[5]],
  ["Jordan Lee", "clicked a link", "Following up on our call · 9m ago · Austin, US", "#2563eb", COLORS[5]],
  ["Daniel Okafor", "opened your email", "Coffee next week? · 25m ago · Toronto, CA", "#16a34a", COLORS[3]],
  ["Priya Shah", "opened your email", "Proposal for Q3 partnership · 2h ago · London, GB", "#16a34a", COLORS[4]],
  ["Hana Kim", "clicked a link", "Re: Product demo recap · 6h ago · Seattle, US", "#2563eb", COLORS[1]],
].map(([n, w, m, dot, c]) => `<li>${av(n, c)}<div><div><span class="dot" style="background:${dot}"></span><b>${n}</b> ${w}</div><div class="sub">${m}</div></div></li>`).join("");
const popupHTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;background:transparent;font:13px/1.5 Inter,ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;color:#0f172a}
  body{padding:60px} .stack{position:relative;width:560px;height:520px}
  .popup{position:absolute;right:0;top:110px;width:360px;background:#fff;border-radius:12px;overflow:hidden;
         box-shadow:0 24px 60px rgba(15,23,42,.28),0 2px 8px rgba(15,23,42,.12);border:1px solid #e6e9ef}
  header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e6e9ef}
  .mark{width:26px;height:26px;display:block} .mark svg{width:100%;height:100%;display:block}
  header b{font-size:14px} header .g{flex:1} header a{color:#64748b;font-size:12px;font-weight:600}
  ul{list-style:none;margin:0;padding:0} li{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid #eef1f5}
  .av{width:30px;height:30px;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:700;font-size:11px;flex:none}
  .sub{color:#64748b;font-size:12px;margin-top:1px} .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:1px}
  footer{padding:9px 14px;background:#f8fafc;color:#64748b;font-size:12px;display:flex;justify-content:space-between}
  .toast{position:absolute;left:0;top:0;width:380px;background:#fbfbfd;border-radius:10px;padding:14px 16px;display:flex;gap:12px;
         box-shadow:0 18px 50px rgba(15,23,42,.30),0 1px 4px rgba(15,23,42,.1);border:1px solid #e5e7eb}
  .toast .mark{width:36px;height:36px;flex:none} .toast .app{font-size:11.5px;color:#6b7280;margin-bottom:3px}
  .toast b{font-size:13.5px} .toast p{margin:2px 0 0;color:#374151}
</style></head><body><div class="stack">
  <div class="toast"><span class="mark">${markSVG("t")}</span><div><div class="app">Google Chrome · now</div><b>MailSpy</b>
    <p>Jordan Lee opened "Following up on our call" from Austin, US</p></div></div>
  <div class="popup"><header><span class="mark">${markSVG("p")}</span><b>MailSpy</b><span class="g"></span><a>Dashboard ›</a></header>
    <ul>${popupItems}</ul><footer><span>you@example.com</span><span>Account</span></footer></div>
</div></body></html>`;
raw.popup = render("raw-popup", popupHTML, 680, 640, 2, work, true);

// ---------------------------------------------------------------- framed listing images
const BG = `radial-gradient(900px 520px at 100% 0%, #d1fae5 0%, transparent 60%),
            radial-gradient(700px 500px at 0% 100%, #e0f2fe 0%, transparent 55%), #f7f9fb`;
function frame({ eyebrow, title, body, bullets, img, imgW, imgH, mode = "window", bleed = false }) {
  const shot = mode === "window"
    ? `<div class="win" style="width:${imgW}px"><div class="bar"><i></i><i></i><i></i><span>mailspy.aryanh.dev</span></div>
         <img src="${fileUrl(img)}" style="width:${imgW}px;height:${imgH}px"></div>`
    : mode === "card"
      ? `<img class="card" src="${fileUrl(img)}" style="width:${imgW}px;height:${imgH}px">`
      : `<img src="${fileUrl(img)}" style="width:${imgW}px;height:${imgH}px">`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0;width:1280px;height:800px;overflow:hidden}
  body{background:${BG};font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;color:#0f172a;
       display:grid;grid-template-columns:390px 1fr;align-items:center;gap:40px;padding:0 0 0 64px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px;margin-bottom:34px}
  .brand .m{width:34px;height:34px;display:block} .brand svg{width:100%;height:100%;display:block}
  .eyebrow{color:#059669;font-weight:800;font-size:13px;letter-spacing:1.4px;text-transform:uppercase;margin-bottom:12px}
  h1{font-size:44px;line-height:1.08;letter-spacing:-1.2px;margin:0 0 18px;font-weight:800}
  p{font-size:18px;line-height:1.5;color:#475569;margin:0 0 22px}
  ul{list-style:none;margin:0;padding:0} li{display:flex;gap:10px;align-items:flex-start;font-size:15.5px;color:#334155;margin:10px 0}
  li svg{width:20px;height:20px;flex:none;margin-top:1px}
  .right{display:flex;justify-content:${bleed ? "flex-start" : "center"};align-items:center;height:800px;padding-right:${bleed ? 0 : 56}px}
  .win{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(15,23,42,.22),0 2px 10px rgba(15,23,42,.08);border:1px solid #e2e8f0}
  .bar{height:38px;background:#f1f5f9;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:7px;padding:0 14px}
  .bar i{width:11px;height:11px;border-radius:50%;background:#cbd5e1} .bar i:first-child{background:#f87171} .bar i:nth-child(2){background:#fbbf24} .bar i:nth-child(3){background:#34d399}
  .bar span{margin-left:16px;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:3px 12px;font-size:12px;color:#64748b}
  .win img{display:block}
  img.card{display:block;border-radius:16px;box-shadow:0 30px 80px rgba(15,23,42,.20),0 2px 10px rgba(15,23,42,.08)}
</style></head><body>
  <div>
    <div class="brand"><span class="m">${markSVG("f")}</span>MailSpy</div>
    <div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${body}</p>
    <ul>${bullets.map(b => `<li><svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#d1fae5" stroke="none"/><path d="m7.5 12.5 3 3 6-6.5"/></svg><span>${b}</span></li>`).join("")}</ul>
  </div>
  <div class="right">${shot}</div>
</body></html>`;
}

const shots = [
  ["screenshot-1-dashboard", frame({
    eyebrow: "Email tracking for Gmail", title: "Know the moment they open it.",
    body: "See who opened your email, how often, and roughly where, all in one live dashboard.",
    bullets: ["Opens and link clicks, per email", "Live activity feed", "Follow-up and open-spike alerts"],
    img: raw.dashboard, imgW: 900, imgH: 562, bleed: true })],
  ["screenshot-2-timeline", frame({
    eyebrow: "Every detail", title: "Every open and click, in order.",
    body: "Open any email for its full story: when it was read, on what device, and which links got clicked.",
    bullets: ["First and last open", "Which links were clicked", "Device and approximate location"],
    img: raw.email, imgW: 900, imgH: 562, bleed: true })],
  ["screenshot-3-notifications", frame({
    eyebrow: "Instant alerts", title: "Get notified as it happens.",
    body: "A desktop notification the moment someone opens your email, plus your latest activity one click away.",
    bullets: ["Desktop notifications", "Activity right in the toolbar", "Works quietly inside Gmail"],
    img: raw.popup, imgW: 680, imgH: 640, mode: "plain" })],
  ["screenshot-4-scheduled", frame({
    eyebrow: "Scheduled sends", title: "Schedule it. Still track it.",
    body: "Use Gmail's own Schedule send as usual. MailSpy tracks the email and shows when it will go out.",
    bullets: ["Works with Gmail's Schedule send", "Send time shown on the dashboard", "Reminders wait until it's sent"],
    img: raw.scheduled, imgW: 817, imgH: 665, mode: "plain" })],
  ["screenshot-5-real-opens", frame({
    eyebrow: "No false alarms", title: "Only real opens count.",
    body: "Your own views, security scanners and mail apps that pre-load images are spotted and left out.",
    bullets: ["Your own views ignored", "Link scanners filtered out", "Delivery-time pre-loads skipped"],
    img: raw.filtered, imgW: 741, imgH: 627, mode: "plain" })],
];
try {
  for (const [name, doc] of shots) console.log("wrote", render(name, doc, 1280, 800, 1, out));

  const promo = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;padding:0 34px;box-sizing:border-box;
      font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;color:#fff;
      background:radial-gradient(420px 260px at 85% 0%,#22c55e55,transparent 70%),linear-gradient(135deg,#0b2e1a,#0f172a);}
    .b{display:flex;align-items:center;gap:12px;font-weight:800;font-size:28px;letter-spacing:-.4px}
    .m{width:56px;height:56px;display:block;filter:drop-shadow(0 6px 16px #05966980)} .m svg{width:100%;height:100%;display:block}
    p{margin:14px 0 0;font-size:19px;line-height:1.35;color:#d1fae5;font-weight:600}
    small{display:block;margin-top:10px;color:#94a3b8;font-size:13px}
  </style></head><body>
    <div class="b"><span class="m">${markSVG("promo")}</span>MailSpy</div>
    <p>Know when your Gmail<br>emails are opened.</p><small>Opens · clicks · scheduled sends</small>
  </body></html>`;
  console.log("wrote", render("promo-small-440x280", promo, 440, 280, 1, out));
} finally {
  rmSync(work, { recursive: true, force: true });
}
