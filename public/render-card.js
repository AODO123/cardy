// Shared card renderer — used by the create form (live preview) and the
// shared card view. Renders a card object into an element.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const SOCIAL_ICONS = {
  discord: '<img src="/discord.png" alt="" class="platform-icon">',
  x: '<img src="/x.png" alt="" class="platform-icon">',
  instagram: '<img src="/instagram.png" alt="" class="platform-icon">',
  tiktok: '<img src="/tiktok.png" alt="" class="platform-icon">',
  // 'spotify' kept so cards created before the switch to X still render.
  spotify: '<img src="/spotify.png" alt="" class="platform-icon">',
};

const SOCIAL_NAMES = {
  discord: 'Discord',
  x: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  spotify: 'Spotify',
};

// Normalize a user-supplied URL to a safe http(s) href, or null.
function safeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const url = new URL(withScheme);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch (_) { /* fall through */ }
  return null;
}

function cardSection(label, inner) {
  return '<div class="card-section"><div class="card-label">' + label + '</div>' + inner + '</div>';
}

function renderCardData(card, el) {
  const name = escapeHtml(card.name || 'Your name');
  const emoji = card.role === 'student' ? '\u{1F393}' : '\u{1F4BC}';
  const roleLine = escapeHtml(card.roleLabel || (card.role === 'student' ? 'Student' : 'Job'));
  const meta = [
    card.age ? '\u{1F382} ' + escapeHtml(card.age) : '',
    card.country ? '\u{1F4CD} ' + escapeHtml(card.country) : '',
  ].filter(Boolean).join(' &middot; ');

  // The owner (site admin) gets a subtle gold badge and a tinted name.
  const ownerBadge = card.owner
    ? ' <span class="owner-badge">Owner</span>'
    : '';

  let html =
    '<div class="card-name' + (card.owner ? ' owner-name' : '') + '">' + name + ownerBadge + '</div>' +
    '<div class="card-role">' + emoji + ' ' + roleLine + '</div>' +
    (meta ? '<div class="card-meta">' + meta + '</div>' : '');

  if (card.aboutMe) {
    html += cardSection('About me', '<div class="card-about">' + escapeHtml(card.aboutMe) + '</div>');
  }

  if (Array.isArray(card.socials) && card.socials.length) {
    const chips = card.socials
      .filter((s) => s && s.handle)
      .map((s) => {
        const icon = SOCIAL_ICONS[s.platform] || '';
        const name = SOCIAL_NAMES[s.platform] || s.platform;
        return '<span class="social-chip" title="' + escapeHtml(name) + '">' + icon + ' ' +
          escapeHtml(s.handle) + '</span>';
      })
      .join(' ');
    if (chips) html += cardSection('Social', '<div class="card-socials">' + chips + '</div>');
  }

  const websiteHref = safeUrl(card.website);
  if (card.website) {
    const link = websiteHref
      ? '<a class="card-link" href="' + escapeHtml(websiteHref) + '" target="_blank" rel="noopener">' + escapeHtml(card.website) + '</a>'
      : escapeHtml(card.website);
    html += cardSection('Website', link);
  }

  if (card.mbti) html += cardSection('Personality', '<div class="card-line">' + escapeHtml(card.mbti) + '</div>');
  if (card.interests) html += cardSection('Interests', '<div class="card-line">' + escapeHtml(card.interests) + '</div>');
  if (card.favoriteMusic || card.favoriteSong) {
    html += cardSection('Favorite song', '<div class="card-line">' + escapeHtml(card.favoriteSong || card.favoriteMusic) + '</div>');
  }
  if (card.favoriteMovie) html += cardSection('Favorite movie / series', '<div class="card-line">' + escapeHtml(card.favoriteMovie) + '</div>');

  el.innerHTML = html;
}
