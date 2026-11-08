// The MailSpy mark, shared by the dashboard, the store images and make-brand.mjs.

// Drawn on a 96×96 grid.
// An eye whose pupil is an envelope: mail that looks back.
export function markSVG(id = "ms") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399"/><stop offset=".55" stop-color="#10b981"/><stop offset="1" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="${id}-shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="${id}-iris" cx=".5" cy=".38" r=".7">
      <stop offset="0" stop-color="#065f46"/><stop offset="1" stop-color="#022c22"/>
    </radialGradient>
  </defs>
  <rect width="96" height="96" rx="26" fill="url(#${id}-bg)"/>
  <rect width="96" height="96" rx="26" fill="url(#${id}-shine)"/>
  <path d="M9.5 48 C23.5 21.5 72.5 21.5 86.5 48 C72.5 74.5 23.5 74.5 9.5 48Z" fill="#fff"/>
  <circle cx="48" cy="48" r="19.5" fill="url(#${id}-iris)"/>
  <rect x="36.5" y="40.25" width="23" height="15.75" rx="3.2" fill="#fff"/>
  <path d="M38.3 42.4 L48 49.6 L57.7 42.4" fill="none" stroke="#064e3b" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}
