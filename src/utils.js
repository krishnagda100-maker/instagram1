export function normalizeIgProfileUrl(href) {
  if (!href) return null;

  // Google SERP links often look like: /url?q=https://instagram.com/handle/&sa=...
  try {
    if (href.startsWith('/url?')) {
      const u = new URL('https://www.google.com' + href);
      const q = u.searchParams.get('q');
      if (q) href = q;
    }
  } catch {}

  if (!href.includes('instagram.com/')) return null;
  if (href.includes('/p/') || href.includes('/reel/') || href.includes('/tv/')) return null;
  if (href.includes('/explore/') || href.includes('/tags/')) return null;

  // Normalize domain + trailing slash
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith('instagram.com')) return null;
    const path = u.pathname.split('?')[0];
    const parts = path.split('/').filter(Boolean);

    // profile is usually /{handle}/
    if (parts.length < 1) return null;
    const handle = parts[0];
    if (!handle || handle.startsWith('p') || handle.startsWith('reel')) return null;

    return `https://www.instagram.com/${handle}/`;
  } catch {
    return null;
  }
}

function parseFollowersFromOgDescription(og) {
  // Example: "12.3K Followers, 120 Following, 87 Posts - ..."
  if (!og) return null;
  const m = og.match(/([\d.,]+)\s*([KMB])?\s+Followers/i);
  if (!m) return null;

  let num = Number(m[1].replace(/,/g, ''));
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1_000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return Math.round(num);
}

function extractEmails(text) {
  if (!text) return [];
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return Array.from(new Set(text.match(re) || []));
}

function extractLinks(text) {
  if (!text) return [];
  const re = /(https?:\/\/[^\s"'<>()]+)|(www\.[^\s"'<>()]+)/gi;
  const matches = text.match(re) || [];
  return Array.from(new Set(matches.map((x) => (x.startsWith('http') ? x : `https://${x}`))));
}

export function parseProfileFromHtml(html, url) {
  if (!html) return null;

  const ogTitle = html.match(/property="og:title"\s*content="([^"]+)"/i)?.[1] ?? null;
  const ogDesc = html.match(/property="og:description"\s*content="([^"]+)"/i)?.[1] ?? null;

  const handle = url?.split('instagram.com/')[1]?.split('/')[0] ?? null;
  const followers = parseFollowersFromOgDescription(ogDesc) ?? 0;

  const emails = extractEmails(html).concat(extractEmails(ogDesc || ''));
  const links = extractLinks(html);

  return {
    handle,
    profile_url: url,
    name: ogTitle,
    bio_text: ogDesc || '',
    followers,
    is_private: false,
    email: emails[0] ?? null,
    external_links: links,
    monetization_domains: links
      .map((l) => {
        try {
          return new URL(l).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })
      .filter(Boolean),
    niche_keywords_matched: [],
    offer_keywords_matched: [],
    last_post_date: null,
    last_post_days: null
  };
}

export async function parseProfileFromPage(page, url) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });

    const content = await page.content();
    const base = parseProfileFromHtml(content, url);
    if (!base) return null;

    const lastTimeIso = await page.evaluate(() => {
      const t = document.querySelector('time');
      return t?.getAttribute('datetime') || null;
    });

    if (lastTimeIso) {
      base.last_post_date = lastTimeIso;
      const diffMs = Date.now() - new Date(lastTimeIso).getTime();
      base.last_post_days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }

    return base;
  } catch {
    return null;
  }
}

export function scoreProfile(profile, { requireLinkOrEmail, activeWithinDays } = {}) {
  const offerKeywords = [
    'apply', 'application', 'book a call', 'schedule', 'coaching', 'mentor', 'mentorship', 'program', 'students',
    'signals', 'community', 'skool', 'discord', 'calendly', 'gumroad', 'stan', 'beacons', 'linktree'
  ];

  const nicheKeywords = ['wholesaling', 'wholesale real estate', 'trading', 'options', 'futures', 'day trader'];

  const bio = (profile.bio_text || '').toLowerCase();
  const domains = (profile.monetization_domains || []).join(' ').toLowerCase();

  let score = 0;

  const offerHits = offerKeywords.filter((k) => bio.includes(k) || domains.includes(k));
  const nicheHits = nicheKeywords.filter((k) => bio.includes(k));

  score += Math.min(35, offerHits.length * 10);
  score += Math.min(20, nicheHits.length * 10);

  if (profile.email) score += 10;
  if (profile.external_links?.length) score += 15;

  if (profile.last_post_days != null) {
    if (activeWithinDays != null && profile.last_post_days <= activeWithinDays) score += 15;
    else score -= 10;
  }

  if (requireLinkOrEmail && !profile.email && (!profile.external_links || profile.external_links.length === 0)) {
    score -= 25;
  }

  profile.offer_keywords_matched = offerHits;
  profile.niche_keywords_matched = nicheHits;
  profile.reason =
    `offerHits=${offerHits.join('|') || 'none'}; ` +
    `nicheHits=${nicheHits.join('|') || 'none'}; ` +
    `linkOrEmail=${!!(profile.email || profile.external_links?.length)}; ` +
    `lastPostDays=${profile.last_post_days ?? 'unknown'}`;

  return Math.max(0, Math.min(100, score));
}

