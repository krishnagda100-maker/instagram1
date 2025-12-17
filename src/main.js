import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, log } from 'crawlee';
import { parseProfileFromHtml, parseProfileFromPage, scoreProfile, normalizeIgProfileUrl } from './utils.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  queries = [
    'site:instagram.com ("wholesaling" OR "wholesale real estate") ("coach" OR "mentorship" OR "apply")',
    'site:instagram.com ("trading" OR "options") ("signals" OR "community" OR "book a call")'
  ],
  maxProfiles = 50,
  minFollowers = 2000,
  activeWithinDays = 60,
  requireLinkOrEmail = true,
  useBrowserForProfiles = true
} = input;

// Proxy is strongly recommended for Google/IG.
const proxyConfiguration = await Actor.createProxyConfiguration();

log.info('Starting Instagram Monetization Lead Finder', { maxProfiles, minFollowers, activeWithinDays });

/**
 * Phase 1: Discovery (Google SERP HTML -> IG profile URLs)
 * NOTE: Google can block scraping. This is best-effort.
 */
const discovered = new Set();

const discoveryCrawler = new CheerioCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl: queries.length,
  async requestHandler({ $, request }) {
    const links = $('a')
      .map((_, el) => $(el).attr('href'))
      .get()
      .filter(Boolean);

    for (const href of links) {
      const url = normalizeIgProfileUrl(href);
      if (url) discovered.add(url);
    }

    log.info('Discovery page processed', { url: request.loadedUrl, totalDiscovered: discovered.size });
  }
});

const googleUrls = queries.map((q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`);
await discoveryCrawler.run(googleUrls);

const discoveredProfiles = Array.from(discovered).slice(0, maxProfiles * 5); // over-collect; we’ll filter later
log.info('Discovery complete', { discoveredProfiles: discoveredProfiles.length });

/**
 * Phase 2: Enrichment (IG profile pages)
 */
const results = [];

const shouldKeep = (profile) => {
  if (!profile) return false;
  if (profile.is_private) return false;
  if (Number.isFinite(minFollowers) && profile.followers < minFollowers) return false;
  if (Number.isFinite(activeWithinDays) && profile.last_post_days != null && profile.last_post_days > activeWithinDays) return false;
  if (requireLinkOrEmail && !profile.email && (!profile.external_links || profile.external_links.length === 0)) return false;
  return true;
};

if (useBrowserForProfiles) {
  const enrichmentCrawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: discoveredProfiles.length,
    async requestHandler({ page, request }) {
      const profile = await parseProfileFromPage(page, request.loadedUrl);
      if (!profile) return;

      profile.score = scoreProfile(profile, { requireLinkOrEmail, activeWithinDays });
      if (shouldKeep(profile)) results.push(profile);

      if (results.length >= maxProfiles) {
        log.info('Reached maxProfiles; aborting.');
        await Dataset.pushData(results);
        process.exit(0);
      }
    }
  });

  await enrichmentCrawler.run(discoveredProfiles);
} else {
  const enrichmentCrawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: discoveredProfiles.length,
    async requestHandler({ request, body }) {
      const html = typeof body === 'string' ? body : body?.toString('utf-8');
      const profile = parseProfileFromHtml(html, request.loadedUrl);
      if (!profile) return;

      profile.score = scoreProfile(profile, { requireLinkOrEmail, activeWithinDays });
      if (shouldKeep(profile)) results.push(profile);
    }
  });

  await enrichmentCrawler.run(discoveredProfiles);
}

log.info('Saving results to dataset', { count: results.length });
await Dataset.pushData(results);

await Actor.exit();
