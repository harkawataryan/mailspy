// HTML pages for the dashboard.
// Design: neutral greys, one accent used only for meaning (opened / links / focus),
// hairline borders instead of shadows, type-led hierarchy, tabular numbers.

import { esc, ago, now } from "./util.js";
import { classifyAgent } from "./tracking.js";
import { markSVG } from "../../brand/mark.js";
import { NOTIFY_KINDS } from "./prefs.js";

const MARK = markSVG("mk");

const STYLE = `<style>
  :root {
    --bg:#fbfbfa; --panel:#ffffff; --sunk:#f6f6f4; --hover:#f4f4f2;
    --line:#e7e7e4; --line-2:#dcdcd8;
    --text:#191919; --text-2:#4a4a48; --muted:#83837f; --faint:#a9a9a5;
    --accent:#0d8a5f; --accent-soft:#e8f5ef;
    --blue:#2f6fde; --blue-soft:#ebf1fd; --amber:#a35d00; --amber-soft:#fdf3e4;
    --red:#c93a2e; --red-soft:#fdeceb;
    --btn:#191919; --btn-text:#ffffff;
    --r:8px; --r-sm:6px;
  }
  /* Dark: forced by the Appearance setting, or following the device unless forced light. */
  :root[data-theme="dark"] {
      --bg:#0f0f10; --panel:#151516; --sunk:#121213; --hover:#1b1b1d;
      --line:#262628; --line-2:#323235;
      --text:#ececea; --text-2:#bdbdb9; --muted:#8a8a86; --faint:#5f5f5c;
      --accent:#3fbf8c; --accent-soft:#11261d;
      --blue:#7aa7f5; --blue-soft:#141e30; --amber:#e3a64b; --amber-soft:#261c0c;
      --red:#f07a6f; --red-soft:#2a1412;
      --btn:#ececea; --btn-text:#111;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0f0f10; --panel:#151516; --sunk:#121213; --hover:#1b1b1d;
      --line:#262628; --line-2:#323235;
      --text:#ececea; --text-2:#bdbdb9; --muted:#8a8a86; --faint:#5f5f5c;
      --accent:#3fbf8c; --accent-soft:#11261d;
      --blue:#7aa7f5; --blue-soft:#141e30; --amber:#e3a64b; --amber-soft:#261c0c;
      --red:#f07a6f; --red-soft:#2a1412;
      --btn:#ececea; --btn-text:#111;
    }
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
         -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  a.link, .prose a { color:var(--accent); }
  a.link:hover, .prose a:hover { text-decoration:underline; }
  code, .mono { font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--sunk);
        border:1px solid var(--line); border-radius:var(--r-sm); padding:12px 14px; margin:0; overflow:auto;
        white-space:pre-wrap; word-break:break-all; }
  .num { font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); }
  .faint { color:var(--faint); }

  /* header */
  .hd { background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:10; }
  .hd-in { max-width:1160px; margin:0 auto; padding:0 28px; height:52px; display:flex; align-items:center; gap:28px; }
  .logo { display:flex; align-items:center; gap:9px; font-weight:600; font-size:14px; letter-spacing:-.1px; }
  .logo svg { width:22px; height:22px; display:block; }
  .hd nav { display:flex; gap:22px; height:100%; }
  .hd nav a, .hd-r a { color:var(--muted); font-size:13.5px; display:flex; align-items:center; height:100%; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .hd nav a:hover, .hd-r a:hover { color:var(--text); }
  .hd nav a.on, .hd-r a.on { color:var(--text); border-bottom-color:var(--text); }
  .hd-r { margin-left:auto; display:flex; align-items:center; gap:20px; height:100%; }
  .hd-r .who { color:var(--faint); font-size:13px; padding-left:20px; border-left:1px solid var(--line); height:20px; display:flex; align-items:center; }
  .acct { position:relative; height:100%; display:flex; align-items:center; }
  .acct summary { list-style:none; cursor:pointer; display:flex; align-items:center; height:100%; }
  .acct summary::-webkit-details-marker { display:none; }
  .acct .av { width:28px; height:28px; border-radius:50%; display:grid; place-items:center; background:var(--accent-soft); color:var(--accent);
              font-size:13px; font-weight:600; transition:box-shadow .12s; }
  .acct summary:hover .av, .acct[open] .av { box-shadow:0 0 0 3px var(--line); }
  .acct .menu { position:absolute; right:0; top:calc(100% + 6px); min-width:230px; padding:6px; background:var(--panel);
                border:1px solid var(--line); border-radius:var(--r, 10px); box-shadow:0 8px 24px rgba(0,0,0,.12); z-index:20; }
  .acct .me { display:flex; flex-direction:column; gap:2px; padding:8px 10px 10px; margin-bottom:4px; border-bottom:1px solid var(--line); font-size:13px; }
  .acct .me b { font-weight:600; color:var(--text); }
  .acct .me span { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hd-r .acct .menu a { display:block; height:auto; margin:0; border:0; padding:8px 10px; border-radius:6px; color:var(--text); font-size:13.5px; }
  .hd-r .acct .menu a:hover, .hd-r .acct .menu a.on { background:var(--sunk); }

  /* layout */
  main { max-width:1160px; margin:0 auto; padding:32px 28px 72px; }
  .head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:22px; }
  h1 { font-size:20px; font-weight:600; letter-spacing:-.3px; margin:0; }
  .head .meta { color:var(--muted); font-size:13px; margin-top:3px; }
  .crumb { font-size:13px; color:var(--muted); margin-bottom:10px; }
  .crumb a:hover { color:var(--text); }
  .cols { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:24px; align-items:start; }
  .cols.even { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
  @media (max-width:980px) { .cols, .cols.even { grid-template-columns:1fr; } .hd-r .who { display:none; } }

  /* panels */
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); }
  .panel + .panel { margin-top:24px; }
  .cols > .panel + .panel { margin-top:0; }
  .ph { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--line); min-height:49px; }
  .ph h2 { font-size:13.5px; font-weight:600; margin:0; }
  .ph .count { color:var(--faint); font-size:13px; font-weight:400; margin-left:6px; }
  .ph .sp { flex:1; }
  .pb { padding:16px; }
  .empty { padding:28px 16px; color:var(--muted); font-size:13.5px; }
  .empty b { color:var(--text); font-weight:500; }

  /* metrics strip */
  .metrics { display:grid; grid-template-columns:repeat(4,1fr); background:var(--panel); border:1px solid var(--line);
             border-radius:var(--r); margin-bottom:24px; }
  .metric { padding:16px 18px; border-left:1px solid var(--line); }
  .metric:first-child { border-left:0; }
  .metric .k { color:var(--muted); font-size:12.5px; }
  .metric .v { font-size:24px; font-weight:600; letter-spacing:-.5px; margin-top:2px; font-variant-numeric:tabular-nums; }
  .metric .v.sm { font-size:15px; letter-spacing:0; margin-top:6px; font-weight:500; }
  .metric .n { color:var(--faint); font-size:12.5px; margin-top:1px; }
  @media (max-width:720px) { .metrics { grid-template-columns:repeat(2,1fr); } .metric:nth-child(3) { border-left:0; }
                             .metric:nth-child(n+3) { border-top:1px solid var(--line); } }

  /* tables */
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-weight:500; font-size:12px; color:var(--muted); padding:9px 16px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:11px 16px; border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td { border-bottom:0; }
  th.r, td.r { text-align:right; }
  tr.row { cursor:pointer; }
  tr.row:hover td { background:var(--hover); }
  .t1 { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:380px; }
  .t2 { color:var(--muted); font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:380px; }
  td.time { color:var(--muted); font-size:13px; white-space:nowrap; }
  tr.dim td { color:var(--faint); }
  tr.dim .t1 { font-weight:400; }

  /* status */
  .st { display:inline-flex; align-items:center; gap:7px; font-size:13px; white-space:nowrap; color:var(--text-2); }
  .st::before { content:""; width:6px; height:6px; border-radius:50%; background:var(--faint); flex:none; }
  .st.open { color:var(--text); } .st.open::before { background:var(--accent); }
  .st.sched::before { background:var(--blue); }
  .st .d { color:var(--muted); }
  .tag { font-size:11.5px; color:var(--muted); border:1px solid var(--line-2); border-radius:4px; padding:0 5px; line-height:17px; white-space:nowrap; }

  /* toolbar (search + filter) */
  .search { position:relative; width:220px; }
  .search input[type=text] { width:100%; height:30px; padding:0 30px; font-size:13px; }
  .search svg { position:absolute; left:9px; top:8px; width:14px; height:14px; color:var(--faint); }
  .search kbd { position:absolute; right:7px; top:6px; font:11px ui-monospace, monospace; color:var(--faint);
                border:1px solid var(--line-2); border-radius:4px; padding:0 4px; line-height:16px; }
  .seg { display:flex; border:1px solid var(--line-2); border-radius:var(--r-sm); overflow:hidden; }
  .seg button { border:0; background:none; padding:0 10px; height:28px; font:inherit; font-size:12.5px; color:var(--muted); cursor:pointer;
                border-left:1px solid var(--line-2); }
  .seg button:first-child { border-left:0; }
  .seg button:hover { color:var(--text); }
  .seg button.on { background:var(--sunk); color:var(--text); font-weight:500; }
  @media (max-width:720px) { .seg { display:none; } .search { width:150px; } }

  /* activity list */
  .ev { list-style:none; margin:0; padding:4px 0; }
  .ev li { display:grid; grid-template-columns:14px minmax(0,1fr) auto; gap:10px; padding:9px 16px; align-items:start; }
  .ev li + li { border-top:1px solid var(--line); }
  .ev .dot { width:7px; height:7px; border-radius:50%; margin-top:7px; background:var(--accent); }
  .ev .dot.click { background:var(--blue); }
  .ev .dot.off { background:transparent; border:1px solid var(--faint); }
  .ev .dot.warn { background:var(--amber); }
  .ev .l1 { font-size:13.5px; }
  .ev .l1 b { font-weight:500; }
  .ev .l2 { font-size:12.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ev .l2 a:hover { color:var(--text); text-decoration:underline; }
  .ev .tm { font-size:12px; color:var(--faint); white-space:nowrap; padding-top:1px; }
  .ev li.off .l1 { color:var(--muted); }

  /* links list */
  .links { list-style:none; margin:0; padding:0; }
  .links li { padding:11px 16px; }
  .links li + li { border-top:1px solid var(--line); }
  .links .u { display:flex; gap:12px; align-items:baseline; font-size:13px; }
  .links .u a { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-2); }
  .links .u a:hover { color:var(--accent); }
  .links .u b { font-weight:600; font-variant-numeric:tabular-nums; }
  .bar { height:3px; background:var(--sunk); border-radius:2px; margin-top:8px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--accent); }

  /* forms */
  label { display:block; font-size:12.5px; font-weight:500; color:var(--text-2); margin:14px 0 6px; }
  label:first-child { margin-top:0; }
  .row2:not(:first-child) label { margin-top:14px; }
  input[type=text], input[type=email], input[type=password], textarea, select {
    width:100%; height:34px; background:var(--panel); color:var(--text); border:1px solid var(--line-2);
    border-radius:var(--r-sm); padding:0 10px; font:inherit; font-size:13.5px; }
  textarea { height:auto; min-height:180px; padding:9px 10px; resize:vertical; line-height:1.5; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .hint { color:var(--muted); font-size:12.5px; margin-top:6px; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:640px) { .row2 { grid-template-columns:1fr; } }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; padding:0 12px; border-radius:var(--r-sm);
         font:inherit; font-size:13px; font-weight:500; cursor:pointer; border:1px solid var(--line-2); background:var(--panel); color:var(--text); white-space:nowrap; }
  .btn:hover { background:var(--hover); }
  .btn.primary { background:var(--btn); color:var(--btn-text); border-color:var(--btn); }
  .btn.primary:hover { opacity:.88; }
  .btn.danger { color:var(--red); }
  .btn.danger:hover { background:var(--red-soft); border-color:var(--red-soft); }
  .btn.block { width:100%; height:36px; }
  .btn.sm { height:28px; padding:0 10px; font-size:12.5px; }
  .actions { display:flex; gap:6px; justify-content:flex-end; }
  form.inline { display:inline; }

  /* notices */
  .note { padding:10px 14px; border-radius:var(--r-sm); margin-bottom:18px; font-size:13.5px; border:1px solid var(--line); background:var(--panel); }
  .note.ok { border-color:color-mix(in srgb, var(--accent) 35%, var(--line)); background:var(--accent-soft); }
  .note.bad { border-color:color-mix(in srgb, var(--red) 35%, var(--line)); background:var(--red-soft); color:var(--red); }
  .note.info { background:var(--sunk); }
  .note pre { margin-top:8px; background:var(--panel); }


  /* settings controls */
  input[type=number] { width:90px; height:34px; background:var(--panel); color:var(--text); border:1px solid var(--line-2);
    border-radius:var(--r-sm); padding:0 8px; font:inherit; font-size:13.5px; }
  input[type=file] { font:inherit; font-size:13px; color:var(--text-2); }
  input[type=checkbox] { accent-color:var(--accent); width:15px; height:15px; margin:0; flex:none; }
  label.chk { display:flex; align-items:center; gap:10px; margin:0 0 10px; font-weight:400; font-size:13.5px; color:var(--text); cursor:pointer; }
  label.chk:last-child { margin-bottom:0; }
  .frow { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:13.5px; margin-bottom:12px; }
  .frow:last-child { margin-bottom:0; }
  .frow .u { color:var(--muted); }
  textarea.list { min-height:84px; font:12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .savebar { position:sticky; bottom:0; display:flex; justify-content:flex-end; gap:12px; align-items:center;
             padding:14px 0; margin-top:8px; border-top:1px solid var(--line); background:var(--bg); }
  .gbtn { display:flex; align-items:center; justify-content:center; gap:10px; height:42px; border-radius:var(--r-sm); border:1px solid var(--line-2);
          background:#fff; color:#1f1f1f; font:500 14px/1 Roboto, Arial, sans-serif; text-decoration:none; }
  .gbtn:hover { background:#f8f9fa; box-shadow:0 1px 3px rgba(60,64,67,.2); }
  .or { display:flex; align-items:center; gap:12px; margin:18px 0 6px; color:var(--faint); font-size:12px; }
  .or::before, .or::after { content:""; flex:1; height:1px; background:var(--line); }
  .autosave { position:fixed; left:50%; bottom:22px; transform:translate(-50%, 8px); opacity:0; pointer-events:none; z-index:40;
              padding:8px 14px; border-radius:999px; background:var(--text); color:var(--bg); font-size:13px;
              transition:opacity .15s, transform .15s; }
  .autosave.on { opacity:1; transform:translate(-50%, 0); }
  .autosave.ok::before { content:"✓ "; }
  .autosave.bad { background:var(--red, #d93025); color:#fff; }
  .ev .dot.doc { background:var(--amber); }
  .pages-chart { list-style:none; margin:0; padding:12px 16px; }
  .pages-chart li { display:grid; grid-template-columns:56px minmax(0,1fr) 64px; gap:12px; align-items:center; font-size:13px; padding:4px 0; }
  .pages-chart .bar { margin:0; height:8px; }
  .pages-chart .s { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .upload { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .copy-in { display:flex; gap:8px; align-items:center; }
  .copy-in input { flex:1; font:12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; height:30px; }

  /* appearance picker */
  .themes { display:grid; grid-template-columns:repeat(3, minmax(0, 150px)); gap:14px; }
  label.th { margin:0; cursor:pointer; display:block; font-size:13px; font-weight:500; color:var(--muted); }
  .th input { position:absolute; opacity:0; pointer-events:none; }
  .sw { display:block; height:78px; border-radius:var(--r-sm); border:1px solid var(--line-2); margin-bottom:8px;
        position:relative; overflow:hidden; transition:border-color .12s, box-shadow .12s; }
  .sw::before { content:""; position:absolute; left:12px; right:26px; top:14px; height:8px; border-radius:3px; background:var(--x1); }
  .sw::after { content:""; position:absolute; left:12px; right:50px; top:30px; height:8px; border-radius:3px; background:var(--x2); }
  .sw i { position:absolute; left:12px; bottom:12px; width:34px; height:12px; border-radius:3px; background:var(--x3); }
  .sw-light { background:#fbfbfa; --x1:#dcdcd8; --x2:#e7e7e4; --x3:#191919; }
  .sw-dark { background:#151516; --x1:#3a3a3d; --x2:#2a2a2c; --x3:#ececea; }
  .sw-system { background:linear-gradient(135deg, #fbfbfa 0 50%, #151516 50% 100%); --x1:#a9a9a5; --x2:#8a8a86; --x3:#3fbf8c; }
  .th:hover .sw { border-color:var(--faint); }
  .th input:checked + .sw { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .th input:focus-visible + .sw { outline:2px solid var(--accent); outline-offset:2px; }
  .th input:checked ~ span { color:var(--text); }
  @media (max-width:520px) { .themes { grid-template-columns:repeat(3, 1fr); gap:8px; } }

  /* settings */
  .sect { display:grid; grid-template-columns:260px minmax(0,1fr); gap:32px; padding:26px 0; border-top:1px solid var(--line); }
  .sect:first-of-type { border-top:0; padding-top:4px; }
  .sect h3 { font-size:14px; font-weight:600; margin:0 0 4px; }
  .sect p.d { color:var(--muted); font-size:13px; margin:0; }
  .sect .body { max-width:520px; }
  .kv { width:100%; }
  .kv td { padding:9px 0; border-bottom:1px solid var(--line); font-size:13.5px; }
  .kv td:first-child { color:var(--muted); width:55%; }
  @media (max-width:820px) { .sect { grid-template-columns:1fr; gap:12px; } }

  /* toast */
  #toast { position:fixed; right:20px; bottom:20px; display:flex; flex-direction:column; gap:8px; z-index:50; }
  .toast { background:var(--text); color:var(--bg); padding:10px 14px; border-radius:var(--r-sm); font-size:13px; max-width:340px;
           box-shadow:0 8px 24px rgba(0,0,0,.18); animation:in .2s ease-out; }
  @keyframes in { from{transform:translateY(6px);opacity:0} to{transform:none;opacity:1} }

  /* auth pages */
  .auth { min-height:100vh; display:grid; place-items:center; padding:24px; }
  .auth .box { width:100%; max-width:360px; }
  .auth .logo { justify-content:center; margin-bottom:28px; font-size:15px; }
  .auth .logo svg { width:28px; height:28px; }
  .auth h1 { font-size:18px; text-align:center; }
  .auth .lead { text-align:center; color:var(--muted); font-size:13.5px; margin:6px 0 22px; }
  .auth .panel { padding:22px; }
  .auth .fine { color:var(--muted); font-size:12px; text-align:center; margin-top:14px; }

  /* document */
  .prose { max-width:680px; }
  .prose h1 { font-size:24px; margin:26px 0 6px; }
  .prose h2 { font-size:15px; font-weight:600; margin:28px 0 6px; }
  .prose p, .prose li { color:var(--text-2); font-size:14.5px; line-height:1.65; }
  .prose ul { padding-left:20px; }
</style>`;

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

// Rendered as UTC, converted to local time in the browser.
function when(ts, style = "full") {
  if (!ts || ts < 0) return "—";
  const iso = new Date(ts * 1000).toISOString();
  return `<time data-ts="${ts}" data-style="${style}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`;
}

function shortAgo(ts) {
  if (!ts) return "";
  const d = Math.floor(now() - ts);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d`;
  return when(ts, "day");
}

const SCRIPT_COMMON = `<script>
document.querySelectorAll("time[data-ts]").forEach(function (el) {
  var d = new Date(parseFloat(el.dataset.ts) * 1000);
  var s = el.dataset.style;
  var o = s === "short" ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : s === "day" ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  el.textContent = d.toLocaleString(undefined, o);
  el.title = d.toLocaleString();
});
document.querySelectorAll("tr.row[data-href]").forEach(function (tr) {
  tr.addEventListener("click", function (e) { if (!e.target.closest("a,button,form")) location.href = tr.dataset.href; });
});
</script>`;

function liveScript(maxAlert, onlyEmailId = null, prefs = null) {
  const kinds = prefs ? Object.keys(prefs.notify).filter(k => prefs.notify[k]) : null;
  return `<div id="toast"></div><script>
(function () {
  var last = ${Number(maxAlert) || 0};
  var only = ${onlyEmailId === null ? "null" : Number(onlyEmailId)};
  var kinds = ${JSON.stringify(kinds)};
  function toast(msg) {
    var el = document.createElement("div"); el.className = "toast"; el.textContent = msg;
    document.getElementById("toast").appendChild(el);
    setTimeout(function () { el.style.transition = "opacity .4s"; el.style.opacity = 0; }, 6000);
    setTimeout(function () { el.remove(); }, 6500);
  }
  async function poll() {
    if (document.hidden) return;
    try {
      var r = await fetch("/live?since=" + last, { credentials: "same-origin" });
      if (!r.ok) return;
      var d = await r.json();
      if (!d.alerts.length) return;
      last = d.max;
      var mine = d.alerts.filter(function (a) { return only === null || a.email_id === only; });
      mine.forEach(function (a) { if (!kinds || kinds.indexOf(a.kind) >= 0) toast(a.message); });
      if (mine.length) setTimeout(function () { location.reload(); }, 3500);
    } catch (e) {}
  }
  setInterval(poll, 10000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
})();
</script>`;
}

function themeOf(user) {
  const t = user && user.theme;
  return t === "light" || t === "dark" ? t : "";
}

function fmtDur(sec) {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtSize(b) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

function copyField(text) {
  return `<div class="copy-in"><input type="text" readonly value="${esc(text)}" onclick="this.select()">
    <button class="btn sm" type="button" onclick="navigator.clipboard.writeText(this.previousElementSibling.value);this.textContent='Copied'">Copy</button></div>`;
}

function shell(title, body, active = "", user = null) {
  const theme = themeOf(user);
  // Main sections only. Documents, Links and Tracked HTML still exist at their
  // addresses (and are linked from the pages that use them), just not up here.
  const items = [["/", "Emails"], ["/find", "Find"], ["/templates", "Templates"], ["/report", "Report"]];
  const nav = items.map(([h, n]) => `<a href="${h}" class="${active === n ? "on" : ""}">${n}</a>`).join("");
  const initial = user ? esc(String(user.name || user.email || "?").trim().charAt(0).toUpperCase()) : "";
  const account = user ? `
    <details class="acct">
      <summary aria-label="Account menu" title="${esc(user.email)}"><span class="av">${initial}</span></summary>
      <div class="menu" role="menu">
        <div class="me">${user.name ? `<b>${esc(user.name)}</b>` : ""}<span>${esc(user.email)}</span></div>
        ${user.is_admin ? `<a href="/admin" role="menuitem"${active === "Friends" ? ' class="on"' : ""}>Friends</a>` : ""}
        <a href="/logout" role="menuitem">Sign out</a>
      </div>
    </details>` : `<a href="/logout">Sign out</a>`;
  return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8"><title>${esc(title)} · MailSpy</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="${theme || "light dark"}">${STYLE}</head><body>
<header class="hd"><div class="hd-in">
  <a class="logo" href="/">${MARK}<span>MailSpy</span></a>
  <nav>${nav}</nav>
  <div class="hd-r">
    <a href="/settings" class="${active === "Settings" ? "on" : ""}">Settings</a>
    ${account}
  </div>
</div></header>
<script>
document.addEventListener("click", function (e) {
  document.querySelectorAll("details.acct[open]").forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute("open"); });
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") document.querySelectorAll("details.acct[open]").forEach(function (d) { d.removeAttribute("open"); });
});
</script>
<main>${body}</main>${SCRIPT_COMMON}</body></html>`;
}

function statusOf(e) {
  const s = e.scheduled_at;
  if (s && s > now()) return "scheduled";
  if (s === -1) return "scheduled";
  return e.opens > 0 ? "opened" : "unopened";
}

function status(e) {
  const s = e.scheduled_at;
  if (s && s > now()) return `<span class="st sched">Scheduled <span class="d">${when(s, "short")}</span></span>`;
  if (s === -1) return `<span class="st sched">Scheduled</span>`;
  if (e.opens > 0) return `<span class="st open">Opened</span>`;
  return `<span class="st">Not opened</span>`;
}

function metrics(items) {
  return `<div class="metrics">${items.map(m => `<div class="metric"><div class="k">${esc(m.k)}</div>
    <div class="v${m.small ? " sm" : ""}">${m.v}</div>${m.n ? `<div class="n">${m.n}</div>` : ""}</div>`).join("")}</div>`;
}

function recipient(e) {
  return esc(e.to_name ? `${e.to_name} · ${e.to_addr}` : e.to_addr);
}

// ---- activity list ----
function activityItem(v) {
  if (v.kind === "doc") {
    const self = v.flagged === "self";
    const who = esc(v.to_name || v.to_addr || "Someone");
    return `<li class="${self ? "off" : ""}"><span class="dot ${self ? "off" : "doc"}"></span>
      <div><div class="l1">${self ? "You viewed a PDF" : `<b>${who}</b> viewed a PDF`}</div>
      <div class="l2"><a href="/docs/${v.item_id}">${esc(v.title)}</a>${v.geo && !self ? ` · ${esc(v.geo)}` : ""}${self ? " · not counted" : ""}</div></div>
      <span class="tm">${shortAgo(v.ts)}</span></li>`;
  }
  if (v.kind === "link") {
    const bot = !!v.flagged;
    return `<li class="${bot ? "off" : ""}"><span class="dot ${bot ? "off" : "click"}"></span>
      <div><div class="l1">${bot ? "Security scanner" : "<b>Someone</b> clicked your tracked link"}</div>
      <div class="l2"><a href="/links/${v.item_id}">${esc(v.title)}</a>${v.geo && !bot ? ` · ${esc(v.geo)}` : ""}${bot ? " · not counted" : ""}</div></div>
      <span class="tm">${shortAgo(v.ts)}</span></li>`;
  }
  const who = esc(v.to_name || v.to_addr);
  let line, dot = v.kind === "click" ? "click" : "", off = false;
  if (v.flagged === "prefetch") { line = `Image loaded right after sending`; dot = "off"; off = true; }
  else if (v.flagged === "scanner") { line = `Security scanner`; dot = "off"; off = true; }
  else if (v.flagged === "self") { line = `You viewed it`; dot = "off"; off = true; }
  else line = `<b>${who}</b> ${v.kind === "open" ? "opened" : "clicked a link"}`;
  const sub = `<a href="/email/${v.email_id}">${esc(v.subject)}</a>${v.geo && !off ? ` · ${esc(v.geo)}` : ""}${off ? " · not counted" : ""}`;
  return `<li class="${off ? "off" : ""}"><span class="dot ${dot}"></span>
    <div><div class="l1">${line}</div><div class="l2">${sub}</div></div><span class="tm">${shortAgo(v.ts)}</span></li>`;
}

// ---- pages ----
export function dashboard({ user, cfg, prefs, emails, totals, activity, reminders, maxAlert, week }) {
  if (prefs && !prefs.show_automated) activity = activity.filter(v => !v.flagged);
  const counts = { all: emails.length, opened: 0, unopened: 0, scheduled: 0 };
  for (const e of emails) counts[statusOf(e)]++;
  const rows = emails.length ? emails.map(e => `<tr class="row" data-href="/email/${e.id}" data-status="${statusOf(e)}"
        data-q="${esc(`${e.subject} ${e.to_name || ""} ${e.to_addr}`.toLowerCase())}">
      <td><div class="t1">${esc(e.subject)}</div><div class="t2">${recipient(e)}</div></td>
      <td>${status(e)}</td>
      <td class="r num">${e.opens || "<span class='faint'>0</span>"}</td>
      <td class="r num">${e.clicks || "<span class='faint'>0</span>"}</td>
      <td class="r time">${e.last_open ? esc(ago(e.last_open)) : "—"}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty"><b>No tracked emails yet.</b> Send one from Gmail with the extension on and it appears here.</div></td></tr>`;

  const pct = totals.total ? Math.round((100 * (totals.opened || 0)) / totals.total) : 0;
  const side = `
    ${reminders.length ? `<div class="panel"><div class="ph"><h2>Needs attention</h2></div>
      <ul class="ev">${reminders.map(a => `<li><span class="dot warn"></span>
        <div><div class="l1">${esc(a.message)}</div><div class="l2"><a href="/email/${a.email_id}">View email</a></div></div>
        <span class="tm">${shortAgo(a.ts)}</span></li>`).join("")}</ul></div>` : ""}
    <div class="panel"><div class="ph"><h2>Activity</h2></div>
      ${activity.length ? `<ul class="ev">${activity.map(activityItem).join("")}</ul>`
        : `<div class="empty">Opens and clicks appear here as they happen.</div>`}</div>`;

  const seg = [["all", "All"], ["opened", "Opened"], ["unopened", "Not opened"], ["scheduled", "Scheduled"]]
    .filter(([k]) => k === "all" || counts[k])
    .map(([k, n]) => `<button type="button" data-f="${k}" class="${k === "all" ? "on" : ""}">${n}</button>`).join("");

  const body = `
  <div class="head"><h1>Emails</h1></div>
  ${!totals.total ? "" : metrics([
    { k: "Tracked", v: totals.total || 0, n: week.sent ? `${week.sent} this week` : "" },
    { k: "Opened", v: totals.opened || 0, n: `${pct}% open rate` },
    { k: "Total opens", v: totals.opens || 0 },
    { k: "Link clicks", v: totals.clicks || 0 },
  ])}
  <div class="cols">
    <div class="panel">
      <div class="ph"><h2>Sent<span class="count">${emails.length}</span></h2><span class="sp"></span>
        ${emails.length ? `<div class="seg" id="seg">${seg}</div>
        <div class="search">${SEARCH_ICON}<input id="q" type="text" placeholder="Search" autocomplete="off"><kbd>/</kbd></div>` : ""}
      </div>
      <div style="overflow-x:auto"><table id="sent">
        <thead><tr><th>Email</th><th>Status</th><th class="r">Opens</th><th class="r">Clicks</th><th class="r">Last opened</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <div class="empty" id="none" hidden>No emails match.</div></div>
    </div>
    <div>${side}</div>
  </div>
  <script>
  (function () {
    var q = document.getElementById("q"); if (!q) return;
    var f = "all", rows = [].slice.call(document.querySelectorAll("#sent tbody tr.row"));
    function apply() {
      var t = q.value.trim().toLowerCase(), shown = 0;
      rows.forEach(function (r) {
        var ok = (f === "all" || r.dataset.status === f) && (!t || r.dataset.q.indexOf(t) >= 0);
        r.hidden = !ok; if (ok) shown++;
      });
      document.getElementById("none").hidden = shown > 0;
    }
    q.addEventListener("input", apply);
    document.getElementById("seg").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      f = b.dataset.f; [].forEach.call(this.children, function (c) { c.classList.toggle("on", c === b); }); apply();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== q && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
      if (e.key === "Escape" && document.activeElement === q) { q.value = ""; apply(); q.blur(); }
    });
  })();
  </script>
  ${liveScript(maxAlert, null, prefs)}`;
  return shell("Emails", body, "Emails", user);
}

export function emailPage({ user, prefs, email: e, links, events, maxAlert, base }) {
  const allEvents = events;
  if (prefs && !prefs.show_automated) events = events.filter(v => !v.is_bot);
  const opens = events.filter(v => !v.is_bot && v.kind === "open");
  const bots = allEvents.filter(v => v.is_bot).length;
  const maxClicks = Math.max(1, ...links.map(l => l.clicks));
  const sentLabel = e.scheduled_at && e.scheduled_at > now() ? "Scheduled for" : e.scheduled_at === -1 ? "Scheduled" : "Sent";
  const sentWhen = e.scheduled_at === -1 ? "" : when(e.scheduled_at && e.scheduled_at > 0 ? e.scheduled_at : e.created_at);

  const evRows = events.length ? events.map(v => {
    let what = v.kind === "open" ? "Opened" : "Clicked a link", why = "";
    if (v.flagged === "prefetch") why = "Image loaded right after sending";
    else if (v.flagged === "scanner") why = "Security scanner";
    else if (v.flagged === "self") why = "You viewed it";
    const main = why ? `${why} <span class="tag">not counted</span>` : what;
    const link = v.url ? `<div class="t2"><a class="link" href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(v.url)}</a></div>` : "";
    return `<tr class="${why ? "dim" : ""}">
      <td><div class="t1" style="max-width:none">${main}</div>${link}</td>
      <td>${esc(classifyAgent(v.user_agent))}</td>
      <td>${esc(v.geo || "—")}</td>
      <td class="r time">${when(v.ts, "short")}</td></tr>`;
  }).join("") : `<tr><td colspan="4"><div class="empty">No opens or clicks yet. They appear here as they happen.</div></td></tr>`;

  const linkList = links.length ? `<ul class="links">${links.map(l => `<li>
      <div class="u"><a href="${esc(l.url)}" target="_blank" rel="noreferrer" title="${esc(l.url)}">${esc(l.url.replace(/^https?:\/\//, ""))}</a><b>${l.clicks}</b></div>
      <div class="bar"><i style="width:${Math.round((100 * l.clicks) / maxClicks)}%"></i></div></li>`).join("")}</ul>`
    : `<div class="empty">This email has no links.</div>`;

  const body = `
  <div class="crumb"><a href="/">Emails</a> &nbsp;/&nbsp; ${esc(e.to_name || e.to_addr)}</div>
  <div class="head"><div><h1>${esc(e.subject)}</h1>
    <div class="meta">To ${esc(e.to_name ? `${e.to_name} <${e.to_addr}>` : e.to_addr)} · ${sentLabel} ${sentWhen}</div></div>
    <div>${status(e)}</div></div>
  ${metrics([
    { k: "Opens", v: e.opens },
    { k: "Clicks", v: e.clicks },
    { k: "First opened", v: when(opens.length ? opens[opens.length - 1].ts : null, "short"), small: true },
    { k: "Last opened", v: when(opens.length ? opens[0].ts : null, "short"), small: true },
  ])}
  <div class="cols">
    <div class="panel"><div class="ph"><h2>Activity<span class="count">${events.length}</span></h2></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Event</th><th>Client</th><th>Location</th><th class="r">Time</th></tr></thead>
      <tbody>${evRows}</tbody></table></div>
      ${bots ? `<div class="pb hint" style="border-top:1px solid var(--line);margin:0">${bots} automated ${bots > 1 ? "hits" : "hit"} left out of the counts.</div>` : ""}</div>
    <div class="panel"><div class="ph"><h2>Links</h2></div>${linkList}</div>
  </div>
  ${liveScript(maxAlert, e.id, prefs)}`;
  return shell(e.subject, body, "Emails", user);
}

export function compose({ user, notice = "", form = {}, result = null }) {
  const res = result ? `<div class="panel" style="margin-bottom:24px"><div class="ph"><h2>Tracked HTML</h2><span class="sp"></span>
      <button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('out').textContent);this.textContent='Copied'">Copy</button></div>
    <div class="pb"><p class="hint" style="margin:0 0 10px">Paste this into your mail app's HTML editor and send it to <b>${esc(form.to)}</b>.</p>
    <pre id="out">${esc(result)}</pre></div></div>` : "";
  const body = `
  <div class="head"><div><h1>Tracked HTML</h1>
    <div class="meta">For mail apps other than Gmail. In Gmail, the extension handles this automatically.</div></div></div>
  ${notice}${res}
  <form method="post" action="/compose" class="panel" style="max-width:720px"><div class="pb">
    <div class="row2">
      <div><label>To</label><input type="email" name="to" required value="${esc(form.to || "")}" placeholder="name@example.com"></div>
      <div><label>Recipient name</label><input type="text" name="to_name" value="${esc(form.to_name || "")}" placeholder="Optional"></div>
    </div>
    <label>Subject</label><input type="text" name="subject" required value="${esc(form.subject || "")}">
    <label>Format</label>
    <select name="fmt">
      <option value="text"${form.fmt !== "html" ? " selected" : ""}>Plain text, links detected automatically</option>
      <option value="html"${form.fmt === "html" ? " selected" : ""}>HTML</option>
    </select>
    <label>Body</label><textarea name="body">${esc(form.body || "")}</textarea>
    <div style="margin-top:16px"><button class="btn primary" type="submit">Generate</button></div>
  </div></form>`;
  return shell("Tracked HTML", body, "Tracked HTML", user);
}

export function report({ user, sent, opened, clicks, bots, top, since, until }) {
  const rate = sent ? Math.round((100 * opened) / sent) : 0;
  const maxOpens = Math.max(1, ...top.map(t => t.opens));
  const rows = top.length ? top.map(t => `<tr class="row" data-href="/email/${t.id}">
      <td><div class="t1">${esc(t.subject)}</div><div class="t2">${esc(t.to_addr)}</div></td>
      <td style="width:40%"><div class="bar" style="margin:0"><i style="width:${Math.round((100 * t.opens) / maxOpens)}%"></i></div></td>
      <td class="r num" style="width:70px">${t.opens}</td></tr>`).join("")
    : `<tr><td colspan="3"><div class="empty">No opens in the last 7 days.</div></td></tr>`;
  const body = `
  <div class="head"><div><h1>Report</h1><div class="meta">Last 7 days · ${when(since, "day")} – ${when(until, "day")}</div></div></div>
  ${metrics([
    { k: "Sent", v: sent },
    { k: "Opened", v: opened, n: `${rate}% open rate` },
    { k: "Link clicks", v: clicks },
    { k: "Automated hits filtered", v: bots },
  ])}
  <div class="panel"><div class="ph"><h2>Most opened</h2></div>
    <table><thead><tr><th>Email</th><th></th><th class="r">Opens</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return shell("Report", body, "Report", user);
}

export function settingsPage({ cfg, base, user, prefs, ip = "", notice = "", gmail = { enabled: false }, hasPassword = true }) {
  const rules = [
    ["Ignore hits right after sending", `${cfg.prefetchWindow} seconds`],
    ["Open spike alert", `${cfg.spikeCount} opens in ${Math.round(cfg.spikeWindow / 60)} minutes`],
    ["Revival alert", `Reopened after ${cfg.revivalDays} quiet days`],
    ["Follow-up reminder", `Not opened within ${cfg.followupHours} hours`],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  const body = `
  <div class="head"><h1>Settings</h1></div>
  ${notice}
  <div class="sect"><div><h3>Account</h3><p class="d">You sign in to the dashboard and the extension with this email.</p></div>
    <div class="body"><table class="kv"><tr><td>Name</td><td>${esc(user.name || "—")}</td></tr>
      <tr><td>Email</td><td>${esc(user.email)}</td></tr></table></div></div>

  <div class="sect"><div><h3>Appearance</h3><p class="d">System follows your device's light or dark setting.</p></div>
    <form class="body" method="post" action="/settings" id="themeForm"><input type="hidden" name="action" value="theme">
      <div class="themes">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([v, n]) =>
        `<label class="th"><input type="radio" name="theme" value="${v}"${(themeOf(user) || "system") === v ? " checked" : ""}>` +
        `<span class="sw sw-${v}"><i></i></span><span>${n}</span></label>`).join("")}</div>
      <noscript><button class="btn" type="submit" style="margin-top:14px">Save</button></noscript>
    </form></div>
  <script>
  (function () {
    var f = document.getElementById("themeForm");
    f.addEventListener("change", function (e) {
      var t = e.target.value, r = document.documentElement;
      if (t === "system") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", t);
      var m = document.querySelector('meta[name="color-scheme"]'); if (m) m.content = t === "system" ? "light dark" : t;
      fetch("/settings", { method: "POST", credentials: "same-origin", headers: { "X-Autosave": "1" }, body: new URLSearchParams(new FormData(f)) })
        .then(function (r) { var s = document.getElementById("autosave"); if (s && r.ok) { s.textContent = "Saved"; s.className = "autosave on ok"; setTimeout(function () { s.className = "autosave"; }, 1800); } });
    });
  })();
  </script>

  <div class="sect"><div><h3>Password</h3><p class="d">${hasPassword ? "At least 10 characters." : "You sign in with Google. Optionally add a password to also sign in with your email."}</p></div>
    <form class="body" method="post" action="/settings">
      ${hasPassword ? `<label>Current password</label><input type="password" name="current_password" required autocomplete="current-password">` : ""}
      <div class="row2">
        <div><label>New password</label><input type="password" name="new_password" required minlength="10" autocomplete="new-password"></div>
        <div><label>Repeat new password</label><input type="password" name="new_password2" required minlength="10" autocomplete="new-password"></div>
      </div>
      <div style="margin-top:16px"><button class="btn" type="submit">${hasPassword ? "Update password" : "Add password"}</button></div>
    </form></div>

  <div class="sect"><div><h3>Chrome extension</h3><p class="d">Tracks the emails you send from Gmail.</p></div>
    <div class="body">
      ${cfg.extensionUrl ? `<p style="margin:0 0 12px"><a class="btn primary" href="${esc(cfg.extensionUrl)}" target="_blank" rel="noreferrer">Add to Chrome</a></p>` : ""}
      <p class="muted" style="margin:0;font-size:13.5px">After installing, click the MailSpy icon in Chrome's toolbar and sign in as <b style="color:var(--text)">${esc(user.email)}</b>.</p>
    </div></div>

  ${gmail.enabled ? `
  <div class="sect"><div><h3>Gmail checkmarks</h3><p class="d">Your tracked sent emails get <b>✔</b> when sent and <b>✔✔</b> once opened, so you can see it in Gmail on any device. Same labels as Mailsuite.</p></div>
    <div class="body">
      ${gmail.error ? `<div class="note bad" style="margin:0 0 12px">${esc(gmail.error)}</div>` : ""}
      ${gmail.connected
        ? `<p style="margin:0 0 12px;font-size:13.5px"><span class="st open">Connected</span> <span class="muted">as ${esc(gmail.email)}</span></p>
           <form method="post" action="/settings" onsubmit="return confirm('Stop adding checkmarks in Gmail? Existing ones stay.')">
             <input type="hidden" name="action" value="gmail_disconnect"><button class="btn sm" type="submit">Disconnect Gmail</button></form>`
        : `<p class="muted" style="margin:0 0 12px;font-size:13.5px">Connect the Gmail account you send from. Google will ask to let MailSpy manage labels; it only ever adds or removes these two checkmarks on emails you tracked.</p>
           <a class="gbtn" href="/auth/google?mode=connect" style="max-width:260px">${G_MARK}<span>Connect Gmail</span></a>`}
    </div></div>` : ""}

  <form method="post" action="/settings" id="prefsForm"><input type="hidden" name="action" value="prefs">
  <div class="sect"><div><h3>Notifications</h3><p class="d">Desktop notifications from the extension, and pop-ups on the dashboard. Everything is still recorded either way.</p></div>
    <div class="body">${NOTIFY_KINDS.map(([k, n]) =>
      `<label class="chk"><input type="checkbox" name="notify_${k}"${prefs.notify[k] ? " checked" : ""}>${esc(n)}</label>`).join("")}</div></div>

  <div class="sect"><div><h3>Alerts and reminders</h3><p class="d">Set any number to 0 to turn that alert off.</p></div>
    <div class="body">
      <div class="frow">Remind me when an email isn't opened within <input type="number" name="followup_hours" min="0" max="1440" value="${prefs.followup_hours}"> <span class="u">hours</span></div>
      <div class="frow">Alert me when an email is reopened after <input type="number" name="revival_days" min="0" max="365" value="${prefs.revival_days}"> <span class="u">quiet days</span></div>
      <div class="frow">Open spike: <input type="number" name="spike_count" min="0" max="50" value="${prefs.spike_count}"> <span class="u">opens within</span>
        <input type="number" name="spike_minutes" min="1" max="1440" value="${prefs.spike_minutes}"> <span class="u">minutes</span></div>
    </div></div>

  <div class="sect"><div><h3>Tracking</h3><p class="d">How your emails are tracked and what counts as a real open.</p></div>
    <div class="body">
      <label class="chk"><input type="checkbox" name="track_all_links"${prefs.track_all_links ? " checked" : ""}>Track every link automatically</label>
      <p class="muted" style="margin:4px 0 0 26px;font-size:12.5px">When off, links are left alone unless you hover one in Gmail and switch on <b>Track clicks</b>.</p>
      <label class="chk"><input type="checkbox" name="show_automated"${prefs.show_automated ? " checked" : ""}>Show automated hits (scanners, my own views) in activity, marked "not counted"</label>
      <div class="frow" style="margin-top:14px">Ignore hits in the first <input type="number" name="prefetch_seconds" min="0" max="600" value="${prefs.prefetch_seconds}"> <span class="u">seconds after sending</span></div>
      <label>Don't track emails to</label>
      <textarea class="list" name="ignore_recipients" placeholder="teammate@company.com&#10;@mycompany.com">${esc(prefs.ignore_recipients.join("\n"))}</textarea>
      <div class="hint">One per line. An address, or @domain.com for everyone at that domain. These emails send without tracking.</div>
      <label>Ignore activity from these IP addresses</label>
      <textarea class="list" name="ignore_ips" placeholder="203.0.113.7">${esc(prefs.ignore_ips.join("\n"))}</textarea>
      <div class="hint">${ip ? `Your current IP address is <code>${esc(ip)}</code>. ` : ""}Opens and clicks from these addresses aren't recorded.</div>
    </div></div>

  <div class="sect"><div><h3>Documents</h3><p class="d">Tracked PDFs you share. See your <a class="link" href="/docs">documents</a> and <a class="link" href="/links">short links</a>.</p></div>
    <div class="body">
      <label class="chk"><input type="checkbox" name="pdf_tiles"${prefs.pdf_tiles ? " checked" : ""}>Send PDFs I attach in Gmail as tracked links</label>
      <div class="hint" style="margin:-4px 0 12px 26px">Off (recommended): PDFs go out as normal Gmail attachments. Those can't report when they're opened, but your email itself is still tracked. On: each PDF is swapped for a link tile that reports opens, time spent and pages read.</div>
      <label class="chk"><input type="checkbox" name="allow_downloads"${prefs.allow_downloads ? " checked" : ""}>Show a download button on my tracked PDFs</label>
      <div class="hint">Hiding the button makes downloading less obvious, but anyone viewing a PDF can still save it.</div>
    </div></div>

  <div class="sect"><div><h3>Email finder</h3><p class="d">Optional. Without a key, Find gives educated guesses; with one, real addresses with names, titles and confidence.</p></div>
    <div class="body">
      <label for="hunter_key">Hunter.io API key</label>
      <input type="password" id="hunter_key" name="hunter_key" autocomplete="off" spellcheck="false" placeholder="Paste your key" value="${esc(prefs.hunter_key || "")}">
      <div class="hint">Free at <a class="link" href="https://hunter.io/users/sign_up" target="_blank" rel="noreferrer">hunter.io</a> (about 50 lookups a month), then copy it from <a class="link" href="https://hunter.io/api-keys" target="_blank" rel="noreferrer">API keys</a>. Results are saved for 30 days, so repeat searches are free.</div>
      <label for="search_key" style="margin-top:16px">Search key, for recruiters on LinkedIn</label>
      <input type="password" id="search_key" name="search_key" autocomplete="off" spellcheck="false" placeholder="Paste a Tavily or SerpApi key" value="${esc(prefs.search_key || "")}">
      <div class="hint">Finds recruiters (and other people) at a company from their public LinkedIn profiles, through a web search; MailSpy never opens LinkedIn itself.
        Free: <a class="link" href="https://app.tavily.com/" target="_blank" rel="noreferrer">Tavily</a> (about 1,000 searches a month, no card) or
        <a class="link" href="https://serpapi.com/users/sign_up" target="_blank" rel="noreferrer">SerpApi</a>. Each company is searched once every two weeks at most.</div>
    </div></div>

  <noscript><div class="savebar"><button class="btn primary" type="submit">Save settings</button></div></noscript>
  </form>
  <div class="autosave" id="autosave" role="status" aria-live="polite"></div>
  <script>
  // Settings save themselves: right away for switches and choices, a moment
  // after you stop typing in a text box.
  (function () {
    var f = document.getElementById("prefsForm"), st = document.getElementById("autosave");
    var timer = null, hideTimer = null, inflight = null, again = false;
    function show(text, cls) {
      clearTimeout(hideTimer);
      st.textContent = text; st.className = "autosave on " + (cls || "");
      if (cls === "ok") hideTimer = setTimeout(function () { st.className = "autosave"; }, 1800);
    }
    async function save() {
      if (inflight) { again = true; return; }
      show("Saving…");
      inflight = fetch("/settings", { method: "POST", credentials: "same-origin",
        headers: { "X-Autosave": "1" }, body: new URLSearchParams(new FormData(f)) });
      try {
        var r = await inflight;
        if (!r.ok) throw new Error(r.status);
        show("Saved", "ok");
      } catch (e) {
        show("Couldn't save. Check your connection.", "bad");
      }
      inflight = null;
      if (again) { again = false; save(); }
    }
    f.addEventListener("change", function () { clearTimeout(timer); save(); });
    f.addEventListener("input", function (e) {
      var t = e.target;
      if (t.type === "checkbox" || t.type === "radio") return;   // "change" covers these
      clearTimeout(timer); timer = setTimeout(save, 700);
    });
    f.addEventListener("submit", function (e) { e.preventDefault(); clearTimeout(timer); save(); });
    addEventListener("beforeunload", function () {
      if (timer) { clearTimeout(timer); navigator.sendBeacon && navigator.sendBeacon("/settings", new URLSearchParams(new FormData(f))); }
    });
  })();
  </script>

  <div class="sect"><div><h3>Server-wide</h3><p class="d">Set by the person who runs this MailSpy.</p></div>
    <div class="body"><p class="hint" style="margin:0"><a class="link" href="/privacy">Privacy policy</a></p></div></div>`;
  return shell("Settings", body, "Settings", user);
}

export function adminPage({ user, base, users, invites, notice = "", created = null }) {
  const link = code => `${base}/signup?code=${code}`;
  const copyBtn = (text, label = "Copy link") =>
    `<button class="btn sm" type="button" onclick="navigator.clipboard.writeText('${esc(text)}');this.textContent='Copied'">${label}</button>`;
  const createdBox = created ? `<div class="note ok"><b>Invite created.</b> Send this link to your friend. It works once.
      <pre>${esc(link(created))}</pre><div style="margin-top:8px">${copyBtn(link(created))}</div></div>` : "";
  const userRows = users.map(u => `<tr>
      <td><div class="t1">${esc(u.name || u.email)}${u.is_admin ? ' &nbsp;<span class="tag">Owner</span>' : ""}</div><div class="t2">${esc(u.email)}</div></td>
      <td class="r num">${u.emails}</td>
      <td class="time">${u.last_sent ? esc(ago(u.last_sent)) : "—"}</td>
      <td class="time">${when(u.created_at, "day")}</td>
      <td><div class="actions">${u.is_admin ? "" : `
        <form class="inline" method="post" action="/admin/user/reset"><input type="hidden" name="id" value="${u.id}">
          <button class="btn sm" type="submit" onclick="return confirm('Give ${esc(u.email)} a new temporary password?')">Reset password</button></form>
        <form class="inline" method="post" action="/admin/user/delete"><input type="hidden" name="id" value="${u.id}">
          <button class="btn sm danger" type="submit" onclick="return confirm('Remove ${esc(u.email)} and permanently delete all of their tracking data?')">Remove</button></form>`}</div></td></tr>`).join("");
  const inviteRows = invites.length ? invites.map(i => `<tr>
      <td><div class="t1">${esc(i.note || "Untitled invite")}</div><div class="t2">Created ${when(i.created_at, "day")}</div></td>
      <td>${i.used_by ? `<span class="st open">Joined as ${esc(i.used_email || "a removed account")}</span>` : '<span class="st sched">Waiting</span>'}</td>
      <td><div class="actions">${i.used_by ? "" : `${copyBtn(link(i.code))}
        <form class="inline" method="post" action="/admin/invite/revoke"><input type="hidden" name="code" value="${esc(i.code)}">
          <button class="btn sm danger" type="submit">Revoke</button></form>`}</div></td></tr>`).join("")
    : `<tr><td colspan="3"><div class="empty">No invites yet.</div></td></tr>`;
  const body = `
  <div class="head"><div><h1>Friends</h1><div class="meta">Each person sees only their own emails.</div></div></div>
  ${notice}${createdBox}
  <div class="panel"><div class="ph"><h2>Invite someone</h2></div>
    <form method="post" action="/admin/invite" class="pb" style="display:flex;gap:10px;align-items:center;max-width:560px">
      <input type="text" name="note" placeholder="Who is it for? (a note for you)" style="flex:1">
      <button class="btn primary" type="submit">Create invite link</button>
    </form></div>
  <div class="panel"><div class="ph"><h2>People<span class="count">${users.length}</span></h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Person</th><th class="r">Emails</th><th>Last sent</th><th>Joined</th><th></th></tr></thead>
    <tbody>${userRows}</tbody></table></div></div>
  <div class="panel"><div class="ph"><h2>Invites</h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>For</th><th>Status</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table></div></div>`;
  return shell("Friends", body, "Friends", user);
}

export function docsPage({ user, base, docs, notice = "", created = null }) {
  const createdBox = created ? `<div class="note ok"><b>${esc(created.filename)} is ready.</b> Share this link anywhere.
      <div style="margin-top:10px">${copyField(created.url)}</div></div>` : "";
  const rows = docs.length ? docs.map(d => `<tr class="row" data-href="/docs/${d.id}">
      <td><div class="t1">${esc(d.filename)}</div><div class="t2">${fmtSize(d.size)}${d.pages ? ` · ${d.pages} page${d.pages > 1 ? "s" : ""}` : ""}</div></td>
      <td class="r num">${d.views || "<span class='faint'>0</span>"}</td>
      <td class="r num">${d.seconds ? fmtDur(d.seconds) : "—"}</td>
      <td class="r time">${d.last_view ? esc(ago(d.last_view)) : "—"}</td>
      <td><div class="actions"><button class="btn sm" type="button" onclick="navigator.clipboard.writeText('${esc(base)}/${esc(d.token)}');this.textContent='Copied'">Copy link</button></div></td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty"><b>No documents yet.</b> Attach a PDF in Gmail as usual and it is tracked when you send, or upload one here to share a link.</div></td></tr>`;
  const body = `
  <div class="head"><div><h1>Documents</h1><div class="meta">Share a PDF and see who opens it, for how long, and which pages they read.</div></div></div>
  ${notice}${createdBox}
  <div class="panel"><div class="ph"><h2>Upload a PDF</h2></div>
    <form class="pb upload" method="post" action="/docs/upload" enctype="multipart/form-data">
      <input type="file" name="file" accept="application/pdf,.pdf" required>
      <button class="btn primary" type="submit">Upload</button>
      <span class="hint" style="margin:0">Up to 15 MB.</span>
    </form></div>
  <div class="panel"><div class="ph"><h2>Your documents<span class="count">${docs.length}</span></h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Document</th><th class="r">Views</th><th class="r">Time viewed</th><th class="r">Last viewed</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
  return shell("Documents", body, "Documents", user);
}

export function docPage({ user, base, doc, views }) {
  const real = views.filter(v => !v.is_self);
  const total = real.reduce((a, v) => a + v.seconds, 0);
  const perPage = {};
  for (const v of real) for (const [pg, sec] of Object.entries(JSON.parse(v.pages_json || "{}"))) perPage[pg] = (perPage[pg] || 0) + sec;
  const nPages = doc.pages || Math.max(0, ...Object.keys(perPage).map(Number));
  const maxSec = Math.max(1, ...Object.values(perPage));
  const chart = nPages ? `<ul class="pages-chart">${Array.from({ length: nPages }, (_, i) => i + 1).map(pg =>
      `<li><span class="muted">Page ${pg}</span><div class="bar"><i style="width:${Math.round((100 * (perPage[pg] || 0)) / maxSec)}%"></i></div><span class="s">${perPage[pg] ? fmtDur(perPage[pg]) : "—"}</span></li>`).join("")}</ul>`
    : `<div class="empty">Page times appear after the first view.</div>`;
  const rows = views.length ? views.map(v => {
    const seen = Object.keys(JSON.parse(v.pages_json || "{}")).length;
    const who = v.is_self ? "You" : esc(v.to_name || v.to_addr || "Someone");
    return `<tr class="${v.is_self ? "dim" : ""}">
      <td><div class="t1">${who}${v.is_self ? ' &nbsp;<span class="tag">not counted</span>' : ""}</div>${v.to_addr && !v.is_self ? `<div class="t2">${esc(v.to_addr)}</div>` : ""}</td>
      <td class="num">${fmtDur(v.seconds)}</td>
      <td class="num">${seen}${nPages ? ` of ${nPages}` : ""}</td>
      <td>${esc(v.geo || "—")}</td>
      <td class="r time">${when(v.ts, "short")}</td></tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty">Nobody has opened this document yet.</div></td></tr>`;
  const body = `
  <div class="crumb"><a href="/docs">Documents</a> &nbsp;/&nbsp; ${esc(doc.filename)}</div>
  <div class="head"><div><h1>${esc(doc.filename)}</h1>
    <div class="meta">${fmtSize(doc.size)}${doc.pages ? ` · ${doc.pages} pages` : ""} · uploaded ${when(doc.created_at, "short")}</div></div>
    <div class="actions"><a class="btn sm" href="/d/${esc(doc.token)}" target="_blank" rel="noreferrer">Open</a>
      <form class="inline" method="post" action="/docs/${doc.id}/delete"><button class="btn sm danger" type="submit"
        onclick="return confirm('Delete this document? Anyone with the link will see that it is no longer available.')">Delete</button></form></div></div>
  <div style="margin-bottom:24px">${copyField(`${base}/${doc.token}`)}</div>
  ${metrics([
    { k: "Views", v: real.length },
    { k: "Total time", v: fmtDur(total) },
    { k: "Average per view", v: real.length ? fmtDur(total / real.length) : "—" },
    { k: "Last viewed", v: when(real.length ? real[0].ts : null, "short"), small: true },
  ])}
  <div class="cols even">
    <div class="panel"><div class="ph"><h2>Views<span class="count">${views.length}</span></h2></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Viewer</th><th>Time</th><th>Pages</th><th>Location</th><th class="r">When</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="panel"><div class="ph"><h2>Time per page</h2></div>${chart}</div>
  </div>`;
  return shell(doc.filename, body, "Documents", user);
}

export function docViewer({ doc, token, r, allowDownload }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.filename)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="dark"><style>
  /* Modelled on Gmail's attachment preview: dark backdrop, slim top bar, pages floating in the middle. */
  * { box-sizing:border-box; }
  html, body { margin:0; background:#3c3c3c; color:#e8eaed; font:14px/1.4 Roboto, "Segoe UI", Arial, sans-serif; }
  .vbar { position:fixed; top:0; left:0; right:0; z-index:5; display:flex; align-items:center; gap:12px; height:56px; padding:0 16px 0 20px;
          background:linear-gradient(rgba(0,0,0,.72), rgba(0,0,0,.55)); }
  .vbar .ic { flex:none; display:inline-block; background:#d93025; color:#fff; font:bold 9px/14px Arial, sans-serif; padding:1px 4px; border-radius:2px; }
  .vbar .f { font-size:15px; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .vbar .sp { flex:1; }
  .vbar a.ib { display:grid; place-items:center; width:40px; height:40px; border-radius:50%; color:#e8eaed; }
  .vbar a.ib:hover { background:rgba(255,255,255,.12); }
  .vbar svg { width:22px; height:22px; }
  #pages { padding:76px 16px 72px; display:flex; flex-direction:column; align-items:center; gap:14px; }
  canvas.pg { display:block; background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.55); max-width:100%; }
  .count { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:5; padding:7px 14px; border-radius:18px;
           background:rgba(0,0,0,.72); color:#e8eaed; font-size:13px; white-space:nowrap; }
  .count:empty { display:none; }
  .state { text-align:center; color:#bdc1c6; padding:80px 20px; }
</style></head><body>
<div class="vbar"><span class="ic">PDF</span><span class="f">${esc(doc.filename)}</span><span class="sp"></span>
  ${allowDownload ? `<a class="ib" href="/d/${esc(token)}/file?dl=1" title="Download" aria-label="Download"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg></a>` : ""}</div>
<div class="count" id="count"></div>
<div id="pages"><div class="state" id="state">Loading…</div></div>
<script type="module">
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const TOKEN = ${JSON.stringify(token)}, R = ${JSON.stringify(r || null)};
const wrap = document.getElementById("pages");
let view = null, pending = {}, pages = 0, current = 1;
const ratios = new Map();
const io = new IntersectionObserver(es => {
  es.forEach(e => ratios.set(+e.target.dataset.page, e.intersectionRatio));
  let best = current, bv = -1; ratios.forEach((v, k) => { if (v > bv) { bv = v; best = k; } }); current = best;
  if (pages > 1) document.getElementById("count").textContent = "Page " + current + " of " + pages;
}, { threshold: [0, .25, .5, .75, 1] });
async function send(beacon) {
  const body = JSON.stringify({ view, r: R, pages, secs: pending }); pending = {};
  if (beacon && view && navigator.sendBeacon) { navigator.sendBeacon("/d/" + TOKEN + "/beat", body); return; }
  try {
    const res = await fetch("/d/" + TOKEN + "/beat", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } });
    const d = await res.json(); if (d.view) view = d.view;
  } catch (e) {}
}
try {
  const pdf = await pdfjs.getDocument("/d/" + TOKEN + "/file").promise;
  pages = pdf.numPages;
  if (pages > 1) document.getElementById("count").textContent = "Page 1 of " + pages;
  document.getElementById("state").remove();
  const dpr = window.devicePixelRatio || 1;
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(wrap.clientWidth - 32, 816);
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const c = document.createElement("canvas");
    c.className = "pg"; c.dataset.page = i; c.width = vp.width; c.height = vp.height;
    c.style.width = vp.width / dpr + "px"; c.style.height = vp.height / dpr + "px";
    wrap.appendChild(c); io.observe(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (i === 1) {
      send();
      setInterval(() => { if (document.visibilityState === "visible" && document.hasFocus()) pending[current] = (pending[current] || 0) + 1; }, 1000);
      setInterval(() => { if (Object.keys(pending).length) send(); }, 10000);
      addEventListener("pagehide", () => send(true));
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") send(true); });
    }
  }
} catch (e) {
  const st = document.getElementById("state"); if (st) st.textContent = "This document couldn't be displayed.";
}
</script></body></html>`;
}

export function docMissing() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Document unavailable</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">${STYLE}</head><body>
<div class="auth"><div class="box" style="text-align:center"><h1>This document is no longer available</h1>
<p class="lead">The person who shared it may have removed it.</p></div></div></body></html>`;
}

// ---------- tracked links ----------
export function linksPage({ user, base, links, notice = "", created = null, form = {} }) {
  const createdBox = created ? `<div class="note ok"><b>Link created.</b> Share it anywhere: messages, LinkedIn, your résumé.
      <div style="margin-top:10px">${copyField(`${base}/${created.token}`)}</div></div>` : "";
  const rows = links.length ? links.map(l => `<tr class="row" data-href="/links/${l.id}">
      <td><div class="t1">${esc(l.label || l.url.replace(/^https?:\/\//, ""))}</div><div class="t2">${esc(base.replace(/^https?:\/\//, ""))}/${esc(l.token)} → ${esc(l.url.replace(/^https?:\/\//, ""))}</div></td>
      <td class="r num">${l.clicks || "<span class='faint'>0</span>"}</td>
      <td class="r time">${l.last_click ? esc(ago(l.last_click)) : "—"}</td>
      <td><div class="actions"><button class="btn sm" type="button" onclick="navigator.clipboard.writeText('${esc(base)}/${esc(l.token)}');this.textContent='Copied'">Copy link</button></div></td></tr>`).join("")
    : `<tr><td colspan="4"><div class="empty"><b>No tracked links yet.</b> Make one above and share it anywhere.</div></td></tr>`;
  const body = `
  <div class="head"><div><h1>Links</h1><div class="meta">Short links you can share anywhere, with every click recorded. Links inside your emails are tracked when you switch on Track clicks.</div></div></div>
  ${notice}${createdBox}
  <div class="panel"><div class="ph"><h2>New tracked link</h2></div>
    <form class="pb" method="post" action="/links" style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto;gap:10px;align-items:center">
      <input type="text" name="url" required placeholder="https://example.com/your-page" value="${esc(form.url || "")}">
      <input type="text" name="label" placeholder="Label (optional)" value="${esc(form.label || "")}">
      <button class="btn primary" type="submit">Create link</button>
    </form></div>
  <div class="panel"><div class="ph"><h2>Your links<span class="count">${links.length}</span></h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Link</th><th class="r">Clicks</th><th class="r">Last click</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
  return shell("Links", body, "Links", user);
}

export function linkPage({ user, base, link, clicks }) {
  const real = clicks.filter(c => !c.is_bot);
  const unique = new Set(real.map(c => c.ip)).size;
  const rows = clicks.length ? clicks.map(c => `<tr class="${c.is_bot ? "dim" : ""}">
      <td>${c.is_bot ? 'Security scanner &nbsp;<span class="tag">not counted</span>' : "Clicked"}</td>
      <td>${esc(classifyAgent(c.user_agent))}</td><td>${esc(c.geo || "—")}</td>
      <td class="r time">${when(c.ts, "short")}</td></tr>`).join("")
    : `<tr><td colspan="4"><div class="empty">No clicks yet.</div></td></tr>`;
  const body = `
  <div class="crumb"><a href="/links">Links</a> &nbsp;/&nbsp; ${esc(link.label || link.token)}</div>
  <div class="head"><div><h1>${esc(link.label || link.url.replace(/^https?:\/\//, ""))}</h1>
    <div class="meta">Goes to <a class="link" href="${esc(link.url)}" target="_blank" rel="noreferrer">${esc(link.url)}</a> · created ${when(link.created_at, "short")}</div></div>
    <form class="inline" method="post" action="/links/${link.id}/delete"><button class="btn sm danger" type="submit"
      onclick="return confirm('Delete this link? It will stop working for anyone who has it.')">Delete</button></form></div>
  <div style="margin-bottom:24px">${copyField(`${base}/${link.token}`)}</div>
  ${metrics([
    { k: "Clicks", v: real.length },
    { k: "Unique visitors", v: unique },
    { k: "First click", v: when(real.length ? real[real.length - 1].ts : null, "short"), small: true },
    { k: "Last click", v: when(real.length ? real[0].ts : null, "short"), small: true },
  ])}
  <div class="panel"><div class="ph"><h2>Clicks<span class="count">${clicks.length}</span></h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Event</th><th>Client</th><th>Location</th><th class="r">When</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  return shell(link.label || "Link", body, "Links", user);
}

export function privacyPage(cfg, base) {
  const contact = cfg.contactEmail
    ? `email <a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>`
    : "contact the person who invited you";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Privacy policy · MailSpy</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">${STYLE}</head><body>
<main class="prose">
  <a class="logo" href="${esc(base)}" style="color:var(--text)">${MARK}<span>MailSpy</span></a>
  <h1>Privacy policy</h1>
  <p>MailSpy is a private, invite-only email tracker run by one person for themselves and a few friends. It is not a commercial service.</p>

  <h2>What MailSpy does</h2>
  <p>When a MailSpy user sends an email from Gmail with the MailSpy Chrome extension, the extension adds a tiny invisible image to the message and routes its links through ${esc(base)}. When the recipient's mail app loads that image or a link is clicked, MailSpy records it so the sender can see that the email was opened.</p>

  <h2>Signing in with Google and Gmail access</h2>
  <p>MailSpy users can sign in with Google. MailSpy then receives their name, email address and Google account ID, and, if they allow it, permission to manage labels in their Gmail (the <code>gmail.modify</code> permission). MailSpy uses that permission only to find the emails the user tracked in their own Sent mail, by recipient, date and subject, and to add or remove two labels on them: ✔ (sent) and ✔✔ (opened). If the user turns on <b>auto-try</b> for an email (sending to several possible addresses for one person, one at a time), MailSpy also looks for delivery-failure notices about that email, re-sends the user's own email to the next address the user chose when one bounces, and moves the failed copy and its failure notice to Trash. It does not otherwise read, store or share the content of any email, and does not send, delete or change anything else. The access token is stored encrypted and can be removed any time under Settings → Gmail checkmarks → Disconnect, or in the Google account's security settings.</p>
  <p>MailSpy's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

  <h2>Data about MailSpy users</h2>
  <ul>
    <li>Your account: email address, optional name, and a hashed password (never the password itself).</li>
    <li>For each tracked email: the recipient's address and name as you entered them, the subject line, the links it contained, and when it was sent or scheduled.</li>
    <li>The extension reads the recipient, subject and body of an email only at the moment you click Send or Schedule send, to add tracking. It does not read your inbox, and it does not store email bodies.</li>
  </ul>

  <h2>Tracked documents and links</h2>
  <p>A MailSpy user can upload a PDF to share through a link, or create a short tracked link to any web page. PDFs are stored on Cloudflare until the user deletes them. When someone opens a shared PDF, MailSpy records when, for how long, which pages were on screen and for how long, and the same technical details as for emails below. When someone follows a tracked link, MailSpy records the click and then sends them on to the destination.</p>

  <h2>Data about email recipients</h2>
  <p>When a tracked email is opened or a link is clicked, MailSpy records the time, the IP address, the approximate location derived from it (city and country), and the browser or mail app's user agent. Many mail providers, including Gmail, fetch images through their own servers, in which case the IP address and location are the provider's, not the recipient's.</p>

  <h2>How it's used and shared</h2>
  <ul>
    <li>Tracking data is shown only to the user who sent the email. Each user sees only their own emails.</li>
    <li>Data is never sold, used for advertising, or shared with anyone else.</li>
    <li>Data is stored on Cloudflare (Workers and D1) in the account of the person who runs this MailSpy, and is sent over HTTPS.</li>
  </ul>

  <h2>Keeping and deleting data</h2>
  <p>Data is kept until the account is removed. Removing an account deletes that user's emails and all tracking data attached to them. To ask for your data to be deleted, or for any question about this policy, ${contact}.</p>

  <h2>Recipients</h2>
  <p>If you received a tracked email and don't want opens recorded, turn off automatic image loading in your mail app. Link clicks pass through MailSpy before reaching their destination.</p>

  <p class="muted" style="margin-top:32px;font-size:13px">Last updated ${new Date().toISOString().slice(0, 10)}.</p>
</main></body></html>`;
}

export function login(cfg, { mode = "login", error = "", form = {} } = {}) {
  const err = error ? `<div class="note bad">${esc(error)}</div>` : "";
  let title = "Sign in to MailSpy", lead = "", inner;
  if (mode === "disabled") {
    inner = `<div class="note info" style="margin:0">Sign-in is off because MailSpy isn't set up yet. In the <code>cloudflare</code> folder, run <code>npm run setup</code>.</div>`;
  } else if (mode === "claim") {
    title = "Claim the owner account";
    lead = "MailSpy now has accounts. Claim the owner account to keep everything you've tracked so far.";
    inner = `${err}<form method="post" action="${esc(cfg.loginPath)}">
      <label>Email</label><input type="email" name="email" required autofocus value="${esc(form.email || "")}" autocomplete="email">
      <label>Name</label><input type="text" name="name" value="${esc(form.name || "")}" autocomplete="name" placeholder="Optional">
      <label>Current dashboard password</label><input type="password" name="password" required autocomplete="current-password">
      <div style="margin-top:18px"><button class="btn primary block" type="submit">Claim account</button></div></form>
      <p class="fine">After this you sign in with this email and the same password.</p>`;
  } else {
    const google = cfg.googleClientId ? `${googleButton("/auth/google?mode=signin", "Continue with Google")}<div class="or"><span>or use your password</span></div>` : "";
    inner = `${err}${google}<form method="post" action="${esc(cfg.loginPath)}">
      <label>Email</label><input type="email" name="email" required ${google ? "" : "autofocus "}value="${esc(form.email || "")}" autocomplete="email">
      <label>Password</label><input type="password" name="password" required autocomplete="current-password">
      <div style="margin-top:18px"><button class="btn ${google ? "" : "primary "}block" type="submit">Sign in</button></div></form>`;
  }
  return authPage("Sign in", title, lead, inner);
}

// Google's sign-in button (their "G" mark and wording).
const G_MARK = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
function googleButton(href, label) {
  return `<a class="gbtn" href="${esc(href)}">${G_MARK}<span>${esc(label)}</span></a>`;
}

export function signup({ code, error = "", form = {}, google = false }) {
  const err = error ? `<div class="note bad">${esc(error)}</div>` : "";
  const g = google ? `${googleButton(`/auth/google?mode=signup&code=${encodeURIComponent(code)}`, "Sign up with Google")}<div class="or"><span>or make a password</span></div>` : "";
  const inner = `${err}${g}<form method="post" action="/signup?code=${encodeURIComponent(code)}">
    <label>Email</label><input type="email" name="email" required autofocus value="${esc(form.email || "")}" autocomplete="email">
    <label>Name</label><input type="text" name="name" value="${esc(form.name || "")}" autocomplete="name">
    <div class="row2">
      <div><label>Password</label><input type="password" name="password" required minlength="10" autocomplete="new-password"></div>
      <div><label>Repeat</label><input type="password" name="password2" required minlength="10" autocomplete="new-password"></div>
    </div>
    <div class="hint">At least 10 characters.</div>
    <div style="margin-top:18px"><button class="btn ${g ? "" : "primary "}block" type="submit">Create account</button></div></form>
    <p class="fine">By creating an account you agree to the <a class="link" href="/privacy">privacy policy</a>.</p>`;
  return authPage("Join MailSpy", "Create your account", "You've been invited to MailSpy, email tracking for Gmail.", inner);
}

function authPage(title, heading, lead, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · MailSpy</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">${STYLE}</head><body>
<div class="auth"><div class="box">
  <div class="logo">${MARK}<span>MailSpy</span></div>
  <h1>${esc(heading)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : `<div style="height:22px"></div>`}
  <div class="panel">${inner}</div>
</div></div></body></html>`;
}

// ---------------------------------------------------------------- short-link address
// What someone sees if they visit the short-link address itself: a plain,
// unbranded link-shortener page. Nothing here mentions tracking or MailSpy.
function shortShell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#18181b; --mute:#71717a; --line:#e4e4e7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f11; --fg:#f4f4f5; --mute:#a1a1aa; --line:#27272a; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:min(420px, 88vw); text-align:center; }
  .mk { width:40px; height:40px; margin:0 auto 18px; border-radius:10px; border:1px solid var(--line);
        display:grid; place-items:center; }
  h1 { font-size:20px; font-weight:600; margin:0 0 6px; letter-spacing:-.01em; }
  p { margin:0; color:var(--mute); }
  a { color:inherit; }
</style></head><body><main>
<div class="mk"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
${inner}
</main></body></html>`;
}

export function shortHome(cfg) {
  const home = cfg.trackHome;
  return shortShell("Short links", `<h1>Short links</h1>
<p>This address hosts short links. Open a full link to be taken to its destination.</p>
${home ? `<p style="margin-top:14px"><a href="${esc(home)}">${esc(home.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></p>` : ""}`);
}

export function shortMissing() {
  return shortShell("Link not found", `<h1>Link not found</h1>
<p>This short link doesn't exist or has expired. Check that it was copied in full.</p>`);
}

// ---------------------------------------------------------------- email finder
export function findPage({ user, hasKey, form = {}, result = null }) {
  const mode = form.mode === "person" ? "person" : "recruiters";
  const tab = (m, label) => `<a class="btn sm${mode === m ? " primary" : ""}" href="/find?mode=${m}">${label}</a>`;
  const compose = email => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`;
  const actions = email => `<div class="actions">
      <button class="btn sm" type="button" onclick="navigator.clipboard.writeText('${esc(email)}');this.textContent='Copied'">Copy</button>
      <a class="btn sm" href="${esc(compose(email))}" target="_blank" rel="noreferrer">Write</a></div>`;
  const conf = p => p.confidence == null ? `<span class="t2">${esc(p.source || "")}</span>` :
    `<span class="st${p.confidence >= 80 ? " open" : ""}">${Number(p.confidence)}%${p.status === "valid" ? ' <span class="d">verified</span>' : p.status === "accept_all" ? ' <span class="d">catch-all</span>' : ""}</span>`;
  const badge = b => `<span class="tag"${/^confirmed/.test(b) ? ' style="color:var(--accent);border-color:var(--accent)"' : ""}>${esc(b)}</span>`;

  let out = "";
  if (result && result.error) out = `<div class="note">${esc(result.error)}</div>`;
  else if (result) {
    const title = esc(result.organization || result.domain || "Results");
    const pattern = result.pattern ? `<div class="hint" style="margin:0 0 12px">Addresses here usually look like <b class="mono">${esc(result.pattern.example)}</b>
      (${result.pattern.votes} of ${result.pattern.named} real addresses found).</div>` : "";
    const people = result.people.length ? `
      <div class="panel"><div class="ph"><h2>${result.mode === "person" ? "Found" : "Recruiting and HR contacts"}<span class="count">${result.people.length}</span></h2>
        ${result.cached ? '<span class="hint" style="margin:0">Saved result, no Hunter credit used</span>' : ""}</div>
        <div style="overflow-x:auto"><table><thead><tr><th>Person</th><th>Email</th><th class="r">Source</th><th></th></tr></thead><tbody>
        ${result.people.map(p => `<tr><td><div class="t1">${esc(p.name || "—")}</div><div class="t2">${esc(p.position || "")}${p.linkedin ? ` · <a class="link" href="${esc(p.linkedin)}" target="_blank" rel="noreferrer">LinkedIn</a>` : ""}</div></td>
          <td class="mono">${esc(p.email)}</td><td class="r">${conf(p)}</td><td>${actions(p.email)}</td></tr>`).join("")}
        </tbody></table></div></div>` : "";
    // People at a company: names and roles by group; each links to a search for that person's address
    const groups = (result.groups || []).map(g => `
      <div class="panel"><div class="ph"><h2>${esc(g.label)}<span class="count">${g.people.length}</span></h2></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Person</th><th>Email</th><th></th></tr></thead><tbody>
        ${g.people.map(p => `<tr><td><div class="t1">${esc(p.name)}</div><div class="t2">${esc([p.position, p.source === "their website" || p.source === "LinkedIn" ? "" : p.source].filter(Boolean).join(" · "))}${p.linkedin ? `${p.position ? " · " : ""}<a class="link" href="${esc(p.linkedin)}" target="_blank" rel="noreferrer">LinkedIn ↗</a>` : ""}</div></td>
          <td>${p.email ? `<span class="mono">${esc(p.email)}</span> <span class="tag" style="color:var(--accent);border-color:var(--accent)">known</span>` : '<span class="t2">not public</span>'}</td>
          <td><div class="actions">${p.email ? actions(p.email) : `<a class="btn sm" href="/find?${esc(new URLSearchParams({ mode: "person", name: p.name, company: result.domain }).toString())}">Find email</a>`}</div></td></tr>`).join("")}
        </tbody></table></div></div>`).join("");
    const published = (result.published || []).length ? `
      <div class="panel"><div class="ph"><h2>Published on their website</h2><span class="hint" style="margin:0">Real addresses</span></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Email</th><th>Found on</th><th></th></tr></thead><tbody>
        ${result.published.map(p => `<tr><td class="mono">${esc(p.email)}${p.hiring ? ` ${badge("hiring")}` : ""}</td>
          <td class="t2">${esc(p.where || "")}</td><td>${actions(p.email)}</td></tr>`).join("")}
        </tbody></table></div></div>` : "";
    const guesses = result.guesses.length ? `
      <div class="panel" id="guesses" data-check="${result.mode === "person" && !result.people.length ? "1" : ""}"><div class="ph"><h2>${result.mode === "person" ? (result.people.length ? "Other possible addresses" : "Likely addresses") : "Usual hiring inboxes"}</h2>
        <span class="hint" style="margin:0">Best first</span></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Email</th><th>Why</th><th></th></tr></thead><tbody>
        ${result.guesses.map(g => `<tr><td class="mono">${esc(g.email)}</td>
          <td>${(g.badges || []).length ? g.badges.map(badge).join(" ") : `<span class="t2">${g.format === "shared inbox" ? "common, unconfirmed" : "common format"}</span>`}</td><td>${actions(g.email)}</td></tr>`).join("")}
        </tbody></table></div></div>` : "";
    const links = (result.links || []).length ? `<p style="margin:0 0 16px;display:flex;gap:8px;flex-wrap:wrap">${result.links.map(l =>
      `<a class="btn sm" href="${esc(l.href)}" target="_blank" rel="noreferrer">${esc(l.label)} ↗</a>`).join("")}</p>` : "";
    out = `<h2 style="margin:24px 0 8px;font-size:15px">${title}${result.domain && result.organization ? ` <span class="faint" style="font-weight:400">${esc(result.domain)}</span>` : ""}</h2>
      ${pattern}${result.notes.map(n => `<div class="note info">${esc(n)}</div>`).join("")}${people}${groups}${links}${result.mode === "recruiters" ? `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Shared inboxes (careers@, jobs@…)</summary>${published}${guesses}</details>` : `${published}${guesses}`}`;
  }

  const fields = mode === "person"
    ? `<input type="text" name="name" required placeholder="Full name or LinkedIn link" value="${esc(form.name || "")}">
       <input type="text" name="company" required placeholder="Company or website, like Stripe or stripe.com" value="${esc(form.company || "")}">`
    : `<input type="text" name="company" required placeholder="Company or website, like Stripe or stripe.com" value="${esc(form.company || "")}" style="grid-column:span 2">`;
  const body = `
  <div class="head"><div><h1>Find</h1><div class="meta">Find someone's work email, or the recruiters at a company. Press Write to start a tracked email in Gmail. Also in Gmail: <b>Find email</b> next to Cc and Bcc.</div></div></div>
  <div class="panel"><div class="ph"><div style="display:flex;gap:8px">${tab("recruiters", "People at a company")}${tab("person", "Find a person")}</div></div>
    <form class="pb" method="get" action="/find" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:center">
      <input type="hidden" name="mode" value="${mode}">${fields}
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div class="pb hint" style="margin:0;padding-top:0">Searches the company's website, public GitHub commits and public keys to learn its address format, and checks Gravatar to confirm addresses.${hasKey ? " Hunter.io results are added on top." : ` For named recruiters with job titles, add a free Hunter.io key in <a class="link" href="/settings#hunter_key">Settings</a>.`}</div></div>
  ${out}
  <script>
  // Check the best guesses against public GitHub commits, from this browser:
  // an address that authored commits definitely exists.
  (async function () {
    var box = document.getElementById("guesses");
    if (!box || !box.dataset.check) return;
    var rows = [].slice.call(box.querySelectorAll("tbody tr")).filter(function (r) { return !/confirmed/.test(r.textContent); }).slice(0, 4);
    for (var i = 0; i < rows.length; i++) {
      var email = rows[i].querySelector("td.mono").textContent.trim();
      try {
        var r = await fetch("https://api.github.com/search/commits?per_page=1&q=" + encodeURIComponent("author-email:" + email), { headers: { Accept: "application/vnd.github+json" } });
        if (!r.ok) return;
        var n = (await r.json()).total_count || 0;
        if (!n) continue;
        rows[i].children[1].innerHTML = '<span class="tag" style="color:var(--accent);border-color:var(--accent)">confirmed: used in ' + n + ' public GitHub commit' + (n === 1 ? "" : "s") + "</span>";
        rows[i].parentElement.insertBefore(rows[i], rows[i].parentElement.firstChild);
        return;
      } catch (e) { return; }
    }
  })();
  </script>`;
  return shell("Find", body, "Find", user);
}

// ---------------------------------------------------------------- templates
function scopeLabel(t) {
  if (t.scope_type === "company") return `<span class="tag">${esc(t.scope_value)}</span>`;
  if (t.scope_type === "person") return `<span class="tag">${esc(t.scope_value)}</span>`;
  return `<span class="t2">Anyone</span>`;
}

function plainPreview(html, n = 90) {
  const t = String(html || "").replace(/<br\s*\/?>|<\/(p|div|li)>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&quot;/g, "'")
    .replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function templatesPage({ user, templates, notice = "" }) {
  const rows = templates.length ? templates.map(t => `<tr class="row" data-href="/templates/${t.id}">
      <td><div class="t1">${esc(t.name)}</div><div class="t2">${esc(t.subject || plainPreview(t.body))}</div></td>
      <td>${scopeLabel(t)}</td>
      <td class="r num">${t.uses || "<span class='faint'>0</span>"}</td>
      <td class="r time">${t.last_used ? esc(ago(t.last_used)) : "—"}</td>
      <td><div class="actions"><a class="btn sm" href="/templates/${t.id}">Edit</a>
        <form method="post" action="/templates/${t.id}/delete" onsubmit="return confirm('Delete this template?')"><button class="btn sm" type="submit">Delete</button></form></div></td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty"><b>No templates yet.</b> Make one here, or write an email in Gmail and use <b>Templates → Save this email</b>.</div></td></tr>`;
  const body = `
  <div class="head"><div><h1>Templates</h1><div class="meta">Reusable emails. In Gmail, the <b>Templates</b> button next to Send inserts one, with ${VARS_TEXT} filled in for whoever you're writing to.</div></div>
    <div><a class="btn primary" href="/templates/new">New template</a></div></div>
  ${notice}
  <div class="panel"><div class="ph"><h2>Your templates<span class="count">${templates.length}</span></h2></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Template</th><th>For</th><th class="r">Used</th><th class="r">Last used</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
  return shell("Templates", body, "Templates", user);
}
const VARS_TEXT = "<code>{first_name}</code> and <code>{company}</code>";

export function templateEdit({ user, t, notice = "", isNew }) {
  const st = t.scope_type || "any";
  const radio = (v, label) => `<label class="chk" style="margin:0"><input type="radio" name="scope_type" value="${v}"${st === v ? " checked" : ""}>${label}</label>`;
  const vars = [["{first_name}", "First name"], ["{last_name}", "Last name"], ["{full_name}", "Full name"], ["{company}", "Company"], ["{my_name}", "Your name"]];
  const body = `
  <div class="head"><div><div class="meta"><a class="link" href="/templates">Templates</a></div><h1>${isNew ? "New template" : esc(t.name)}</h1></div></div>
  ${notice}
  <form method="post" action="${isNew ? "/templates/new" : `/templates/${t.id}`}" id="tf">
  <div class="panel"><div class="pb">
    <label for="tname">Name</label><input id="tname" type="text" name="name" required maxlength="120" placeholder="Like: Coffee chat ask, Referral follow-up" value="${esc(t.name || "")}">
    <label>Use for</label>
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">${radio("any", "Anyone")}${radio("company", "A company")}${radio("person", "One person")}</div>
    <input type="text" name="scope_value" id="sv" placeholder="" value="${esc(t.scope_value || "")}" style="margin-top:8px${st === "any" ? ";display:none" : ""}">
    <div class="hint" id="svh"></div>
    <label for="tsub">Subject</label><input id="tsub" type="text" name="subject" maxlength="300" placeholder="Optional. Only used if the email has no subject yet." value="${esc(t.subject || "")}">
    <label>Message</label>
    <div class="ed-bar">
      <button type="button" class="btn sm" data-cmd="bold"><b>B</b></button>
      <button type="button" class="btn sm" data-cmd="italic"><i>I</i></button>
      <button type="button" class="btn sm" data-cmd="link">Link</button>
      <span class="ed-sep"></span>
      ${vars.map(([v, l]) => `<button type="button" class="btn sm" data-var="${v}" title="Insert ${v}">${l}</button>`).join("")}
    </div>
    <div class="ed" id="ed" contenteditable="true">${t.body || ""}</div>
    <input type="hidden" name="body" id="tbody">
    <div class="hint">Placeholders like <code>{first_name}</code> are filled in from the recipient when you insert the template in Gmail. Any that can't be worked out stay highlighted for you to fill in.</div>
  </div>
  <div class="savebar"><a class="btn" href="/templates">Cancel</a><button class="btn primary" type="submit">Save template</button></div></div>
  </form>
  <style>
    .ed-bar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
    .ed-sep { width:1px; height:18px; background:var(--line-2); margin:0 4px; }
    .ed { min-height:220px; border:1px solid var(--line-2); border-radius:8px; padding:12px 14px; background:var(--bg-2, transparent);
          font:14px/1.6 Arial, Helvetica, sans-serif; outline:none; overflow-wrap:anywhere; }
    .ed:focus { border-color:var(--accent); }
  </style>
  <script>
  (function () {
    var ed = document.getElementById("ed"), sv = document.getElementById("sv"), svh = document.getElementById("svh");
    function scope() {
      var v = document.querySelector('input[name=scope_type]:checked').value;
      sv.style.display = v === "any" ? "none" : "";
      sv.placeholder = v === "company" ? "Company email domain, like stripe.com" : "Their email address";
      svh.textContent = v === "company" ? "Suggested first when you write to anyone at this company." : v === "person" ? "Suggested first when you write to this person." : "";
    }
    document.querySelectorAll('input[name=scope_type]').forEach(function (r) { r.addEventListener("change", scope); });
    scope();
    document.querySelectorAll(".ed-bar [data-cmd]").forEach(function (b) {
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function () {
        ed.focus();
        var c = b.getAttribute("data-cmd");
        if (c === "link") { var u = prompt("Link address"); if (u) document.execCommand("createLink", false, /^https?:/i.test(u) ? u : "https://" + u); }
        else document.execCommand(c);
      });
    });
    document.querySelectorAll(".ed-bar [data-var]").forEach(function (b) {
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function () { ed.focus(); document.execCommand("insertText", false, b.getAttribute("data-var")); });
    });
    document.getElementById("tf").addEventListener("submit", function () { document.getElementById("tbody").value = ed.innerHTML; });
  })();
  </script>`;
  return shell(isNew ? "New template" : t.name, body, "Templates", user);
}

// ---------------------------------------------------------------- extension sign-in
// After "Sign in with Google" from the extension, this page hands the extension
// its key: the extension's content script reads the data-* attributes below,
// saves them, and marks the page done.
export function extensionLink(user) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connecting MailSpy</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">${STYLE}</head><body>
<div class="auth"><div class="box" style="text-align:center">
  <div class="logo" style="justify-content:center">${MARK}<span>MailSpy</span></div>
  <div id="mailspy-ext-link" data-key="${esc(user.api_key)}" data-email="${esc(user.email)}" data-name="${esc(user.name || "")}"></div>
  <h1 id="t">Connecting the extension…</h1>
  <p class="lead" id="d">Keep this tab open for a moment.</p>
  <p id="x" style="display:none"><a class="btn" href="/">Go to your dashboard</a></p>
</div></div>
<script>
(function () {
  var box = document.getElementById("mailspy-ext-link");
  function done() {
    document.getElementById("t").textContent = "You're signed in";
    document.getElementById("d").textContent = "The MailSpy extension is connected to " + box.getAttribute("data-email") + ". You can close this tab.";
    document.getElementById("x").style.display = "";
  }
  if (box.getAttribute("data-connected")) return done();
  new MutationObserver(function () { if (box.getAttribute("data-connected")) done(); }).observe(box, { attributes: true });
  setTimeout(function () {
    if (box.getAttribute("data-connected")) return;
    document.getElementById("t").textContent = "The extension didn't respond";
    document.getElementById("d").textContent = "Make sure the MailSpy extension is installed and turned on, then try signing in from it again.";
    document.getElementById("x").style.display = "";
  }, 6000);
})();
</script></body></html>`;
}
