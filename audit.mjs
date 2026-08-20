/**
 * Does every product card show the right thing?
 *
 * Catches the failure that actually happened repeatedly by hand: a card
 * labelled "Hộp quà" showing loose seeds, or an image that 404s after a
 * rename. Runs against the live site, so it also catches a bad deploy.
 *
 *   node audit.mjs                      # live site
 *   BASE=http://localhost:8123 node audit.mjs
 *
 * Exits non-zero on any mismatch, so CI fails loudly.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://hienhoa.com';

// What each card is allowed to show. A card whose title mentions a box may
// never point at a seed photo: a gift box is our own packaging, so the only
// correct image is a real photograph of it.
const RULES = [
  { match: /hạt dưa/i,        allow: /hatdua/,       label: 'seed photo' },
  { match: /hạt bí/i,         allow: /hatbi/,        label: 'pumpkin seed photo' },
  { match: /^hộp/i,           allow: null,           label: 'own photograph only' },
  { match: /d3|k2/i,          allow: /d3k2/,         label: 'softgel photo' },
  { match: /omega|dầu cá/i,   allow: /omega3/,       label: 'fish oil photo' },
  { match: /vitamin tổng hợp/i, allow: /multivitamin/, label: 'tablet photo' },
  { match: /whey|protein/i,   allow: null,           label: 'own photograph only' },
];

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on('requestfailed', r => problems.push(`request failed: ${r.url()}`));
page.on('response', r => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/?cb=${Date.now()}`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);

const cards = await page.$$eval('article.p', els => els.map(e => {
  const img = e.querySelector('img');
  return {
    title: e.querySelector('h3')?.textContent?.trim() || '',
    src: img?.getAttribute('src') || null,
    alt: img?.getAttribute('alt') || null,
    loaded: img ? img.naturalWidth > 0 : null,
    awaiting: !!e.querySelector('.shot.await'),
  };
}));

if (!cards.length) problems.push('no product cards found at all');

console.log(`${cards.length} cards on ${BASE}\n`);
for (const c of cards) {
  const rule = RULES.find(r => r.match.test(c.title));
  let verdict = 'ok';

  if (c.awaiting) {
    // Deliberate empty state. Only acceptable where a stock photo cannot be
    // correct, i.e. our own packaging.
    verdict = rule && rule.allow === null ? 'awaiting photo (expected)' : 'awaiting photo';
    if (rule && rule.allow !== null) {
      problems.push(`${c.title}: has no image but a ${rule.label} exists for it`);
      verdict = 'MISSING IMAGE';
    }
  } else if (!c.src) {
    problems.push(`${c.title}: no image and no awaiting state`);
    verdict = 'NO IMAGE';
  } else if (!c.loaded) {
    problems.push(`${c.title}: image ${c.src} did not load`);
    verdict = 'BROKEN';
  } else if (!rule) {
    verdict = 'no rule (add one)';
  } else if (rule.allow === null) {
    problems.push(`${c.title}: shows ${c.src}, but this card needs ${rule.label}`);
    verdict = 'MISMATCH';
  } else if (!rule.allow.test(c.src)) {
    problems.push(`${c.title}: shows ${c.src}, expected ${rule.label}`);
    verdict = 'MISMATCH';
  }

  console.log(`  ${c.title.padEnd(32)} ${(c.src || 'awaiting').padEnd(26)} ${verdict}`);
}

// Things that are legally required or simply must not regress.
const html = await page.content();
const MUST = [
  ['Hiển Hòa', 'brand name'],
  ['0913353300', 'phone number'],
  ['không phải là thuốc và không có tác dụng', 'supplement disclaimer (Nghị định 15/2018)'],
];
for (const [needle, what] of MUST) {
  if (!html.includes(needle)) problems.push(`missing ${what}`);
}

await page.screenshot({ path: 'audit-full.png', fullPage: true });
await browser.close();

console.log('');
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('All cards match their labels. All required text present.');
