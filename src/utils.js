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

// Add additional utility functions as specified above.
