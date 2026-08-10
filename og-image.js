// Open Graph card image — a flat PNG picture of a card, so pasted links
// preview with an actual card graphic instead of a bare URL. The graphic is
// drawn as an SVG and rasterized to PNG with resvg; the platforms that build
// link previews refuse to render SVG, so it has to be a real PNG.
//
// Two layouts: when the card has a photo it's a full card (circular portrait
// on the left, details on the right); without a photo it falls back to a
// minimal card that just shows the name and the about-me line.

const fs = require('fs');
const path = require('path');

// Icons are embedded as data URIs so the PNG is fully self-contained. public/
// ships with the deploy, so these files exist at runtime.
const ICON_SOURCES = ['cardy', 'job', 'student', 'discord', 'x', 'instagram', 'tiktok'];
const ICONS = {};
for (const name of ICON_SOURCES) {
  ICONS[name] =
    'data:image/png;base64,' +
    fs.readFileSync(path.join(__dirname, 'public', name + '.png')).toString('base64');
}

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));

// Squeeze whitespace and cap length with an ellipsis — long names or bios
// would push text off the edge of the card.
const truncate = (s, max) => {
  const clean = String(s || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
};

const ROLE_ICON = { student: 'student', job: 'job' };
const SOCIAL_ICON = { discord: 'discord', x: 'x', instagram: 'instagram', tiktok: 'tiktok' };

// A rounded pill holding a platform icon + handle, used for the social row.
function socialPill(x, y, width, platform, handle) {
  const label = escapeXml(handle);
  return (
    `<rect x="${x}" y="${y}" width="${width}" height="36" rx="18" fill="#000" opacity="0.22" />` +
    `<rect x="${x}" y="${y}" width="${width}" height="36" rx="18" fill="none" stroke="#fff" stroke-opacity="0.28" stroke-width="1.5" />` +
    `<image href="${ICONS[platform]}" x="${x + 12}" y="${y + 9}" width="18" height="18" />` +
    `<text x="${x + 40}" y="${y + 24}" font-size="19" fill="#fff" fill-opacity="0.95">${label}</text>`
  );
}

// Lay the social pills out two per row so they never overflow the card. The
// starting x and row tops shift depending on whether a photo takes the left
// side of the card.
function socialRows(socials, startX = 304, rowTops = [484, 532]) {
  const items = [];
  for (const s of socials || []) {
    if (!s || !s.handle) continue;
    const platform = SOCIAL_ICON[s.platform];
    if (!platform) continue;
    items.push({ platform, handle: truncate(s.handle, 16) });
    if (items.length === 4) break;
  }
  if (!items.length) return '';
  let out = '';
  let row = 0;
  let x = startX;
  for (const item of items) {
    const width = 46 + item.handle.length * 11.5; // icon + padding + text
    if (x + width > 896) { // second row, card's inner right edge
      row = 1;
      x = startX;
    }
    out += socialPill(x, rowTops[row], width, item.platform, item.handle);
    x += width + 12;
  }
  return out;
}

const goldBadge = (x, y) =>
  `<rect x="${x}" y="${y}" width="86" height="28" rx="14" fill="#ffd166" fill-opacity="0.16" stroke="#ffd166" stroke-opacity="0.55" />` +
  `<text x="${x + 43}" y="${y + 19}" font-size="13" font-weight="700" letter-spacing="1" fill="#ffd166" text-anchor="middle" style="text-transform:uppercase">Owner</text>`;

// Background, brand header and footer — the frame shared by both layouts.
const chrome = (defs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
  `<defs>${defs}<linearGradient id="card" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#b48cff"/>` +
  `</linearGradient></defs>` +
  `<rect width="1200" height="630" fill="#0d0f17"/>` +
  `<circle cx="1080" cy="40" r="300" fill="#8b7bff" opacity="0.08"/>` +
  `<circle cx="120" cy="600" r="280" fill="#8b7bff" opacity="0.06"/>` +
  `<image href="${ICONS.cardy}" x="86" y="46" width="30" height="30"/>` +
  `<text x="128" y="72" font-size="40" font-weight="800" fill="#8b7bff">cardy</text>` +
  `<text x="128" y="98" font-size="20" fill="#9aa3b5">your tiny digital card</text>` +
  `<rect x="260" y="150" width="680" height="430" rx="24" fill="url(#card)"/>`;

const footer =
  `<text x="1200" y="600" font-size="18" fill="#9aa3b5" text-anchor="end">cardy · your tiny digital card</text>`;

// Full card with a circular photo on the left and the details to its right.
function photoLayout(card) {
  const isOwner = !!(card && card.owner);
  const name = truncate(card.name, 16);
  const roleIcon = ROLE_ICON[card.role] || 'job';
  const roleLine = truncate(
    card.roleLabel || (card.role === 'student' ? 'Student' : 'your tiny digital card'),
    24
  );
  const meta = [card.age, card.country].filter(Boolean).join(' · ');
  const about = truncate(card.aboutMe, 60);
  const contentX = 480; // content sits right of the photo

  // Badge sits right after the name text. Name starts at contentX, and each
  // char is roughly 27px wide at font 44 bold.
  const badgeX = isOwner ? contentX + name.length * 27 + 12 : 0;
  const badge = isOwner ? goldBadge(badgeX, 222) : '';

  const socials = socialRows(card.socials, contentX, about ? [462, 510] : [426, 474]);

  return (
    `<image href="${escapeXml(card.photo)}" x="305" y="245" width="150" height="150" clip-path="url(#pfp)" preserveAspectRatio="xMidYMid slice"/>` +
    `<text x="${contentX}" y="252" font-size="44" font-weight="800" fill="${isOwner ? '#ffd166' : '#ffffff'}">${escapeXml(name)}</text>` +
    badge +
    `<image href="${ICONS[roleIcon]}" x="${contentX}" y="278" width="20" height="20"/>` +
    `<text x="${contentX + 30}" y="296" font-size="24" fill="#fff" fill-opacity="0.95">${escapeXml(roleLine)}</text>` +
    (meta
      ? `<text x="${contentX}" y="348" font-size="22" fill="#fff" fill-opacity="0.9">${escapeXml(meta)}</text>`
      : '') +
    (about
      ? `<line x1="${contentX}" y1="384" x2="896" y2="384" stroke="#fff" stroke-opacity="0.3" />` +
        `<text x="${contentX}" y="420" font-size="21" fill="#fff" fill-opacity="0.95">${escapeXml(about)}</text>`
      : '') +
    socials
  );
}

// No photo — the preview is just the name and the about-me line, centered.
function minimalLayout(card) {
  const isOwner = !!(card && card.owner);
  const name = truncate(card ? card.name : 'cardy', 18);
  const about =
    truncate(card && card.aboutMe, 46) ||
    truncate(
      (card && card.roleLabel) || (card && card.role === 'student' ? 'Student' : 'your tiny digital card'),
      40
    );
  const badge = isOwner ? goldBadge(600 - 43, 300) : '';
  const aboutY = isOwner ? 375 : 348;

  return (
    `<text x="600" y="280" font-size="52" font-weight="800" text-anchor="middle" fill="${isOwner ? '#ffd166' : '#ffffff'}">${escapeXml(name)}</text>` +
    badge +
    `<text x="600" y="${aboutY}" font-size="24" text-anchor="middle" fill="#fff" fill-opacity="0.95">${escapeXml(about)}</text>`
  );
}

// Build the SVG for a card (or a generic brand card when none is found).
function cardSvg(card) {
  const body = card && card.photo ? photoLayout(card) : minimalLayout(card);
  const defs = card && card.photo ? `<clipPath id="pfp"><circle cx="380" cy="320" r="75"/></clipPath>` : '';
  return chrome(defs) + body + footer + `</svg>`;
}

module.exports = { cardSvg };
