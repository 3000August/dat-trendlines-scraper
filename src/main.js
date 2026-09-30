/**
 * DAT Trendlines Freight Scraper
 * Intercepts DAT's internal API calls to extract:
 *   - National rates (Van/Reefer/Flatbed, weekly $/mile)
 *   - Load-to-truck ratios per state
 *   - Fuel prices by region
 *   - State-level rate data (where available)
 */

import { Actor, log } from 'apify';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

// ── URL map ──────────────────────────────────────────────────────────────────
const PAGE_URLS = {
  VAN: {
    national_rates:   'https://www.dat.com/trendlines/van/national-rates',
    load_truck_ratio: 'https://www.dat.com/trendlines/van/load-to-truck-ratio',
    state_rates:      'https://www.dat.com/trendlines/van/state-rates',
  },
  REEFER: {
    national_rates:   'https://www.dat.com/trendlines/reefer/national-rates',
    load_truck_ratio: 'https://www.dat.com/trendlines/reefer/load-to-truck-ratio',
    state_rates:      'https://www.dat.com/trendlines/reefer/state-rates',
  },
  FLATBED: {
    national_rates:   'https://www.dat.com/trendlines/flatbed/national-rates',
    load_truck_ratio: 'https://www.dat.com/trendlines/flatbed/load-to-truck-ratio',
    state_rates:      'https://www.dat.com/trendlines/flatbed/state-rates',
  },
};

const FUEL_URL = 'https://www.dat.com/trendlines/fuel-prices';

// API patterns to intercept — DAT loads chart data via these internal endpoints
const API_PATTERNS = [
  /trendlines.*api/i,
  /dat\.com\/api\//i,
  /trendline.*data/i,
  /\/rates\//i,
  /\/fuel\//i,
  /\/ltr\//i,
  /\/load-to-truck\//i,
  /freightmarket/i,
  /freight-rates/i,
];

// DOM selectors as fallback if no API call is intercepted
const DOM_SELECTORS = {
  rate:  '[data-testid="rate-value"], .rate-value, .current-rate, [class*="rate"]',
  ltr:   '[data-testid="ltr-value"], .ltr-value, [class*="load-to-truck"]',
  state: '[data-testid="state-row"], .state-row, table tbody tr',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function looksLikeFreightData(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = JSON.stringify(obj).toLowerCase();
  return (
    keys.includes('rate') ||
    keys.includes('loadcount') ||
    keys.includes('truckcount') ||
    keys.includes('ltr') ||
    keys.includes('fuel') ||
    keys.includes('statecode') ||
    keys.includes('permileprice') ||
    keys.includes('spotrate')
  );
}

async function launchBrowser(headless) {
  return puppeteerExtra.launch({
    headless: headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
}

// ── Core page scraper ─────────────────────────────────────────────────────────
async function scrapePage({ browser, url, equipment, dataset, maxRetries }) {
  const captured = [];
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const page = await browser.newPage();

    try {
      // Set realistic headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      );

      // ── Intercept all responses ──────────────────────────────────────────
      page.on('response', async (response) => {
        const respUrl = response.url();
        const status  = response.status();
        const ct      = response.headers()['content-type'] || '';

        if (status !== 200 || !ct.includes('json')) return;

        // Only process URLs matching our patterns OR dat.com API calls
        const relevant = API_PATTERNS.some(p => p.test(respUrl)) ||
                         respUrl.includes('dat.com') && respUrl.includes('/api');
        if (!relevant) return;

        try {
          const body = await response.json();
          if (looksLikeFreightData(body)) {
            log.info(`[${equipment}/${dataset}] Captured API response from: ${respUrl}`);
            captured.push({ source_url: respUrl, data: body });
          }
        } catch {
          // Not JSON or parse error — skip
        }
      });

      log.info(`[${equipment}/${dataset}] Navigating to: ${url} (attempt ${attempt})`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });

      // Wait for dynamic content to load
      await sleep(4000);

      // Scroll to trigger lazy-loaded charts
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(2000);

      // ── DOM fallback: extract visible data if no API captured ────────────
      if (captured.length === 0) {
        log.info(`[${equipment}/${dataset}] No API calls captured, attempting DOM extraction`);
        const domData = await page.evaluate((selectors, eq, ds) => {
          const results = [];

          // Try to find any visible numeric data in the page
          const allText = document.body.innerText;

          // Look for rate patterns like $2.14/mi or 2.14
          const ratePattern = /\$?(\d+\.\d{2})\s*(?:\/mi|per mile)?/gi;
          const ltrPattern  = /(\d+\.\d{1,2})\s*(?:loads?\s*per\s*truck|ltr|load.to.truck)/gi;

          let m;
          while ((m = ratePattern.exec(allText)) !== null) {
            const val = parseFloat(m[1]);
            if (val > 1.0 && val < 10.0) { // Reasonable rate range
              results.push({ type: 'rate', value: val, equipment: eq, dataset: ds });
            }
          }

          // Try table rows for state data
          const rows = document.querySelectorAll('table tbody tr, [class*="table"] [class*="row"]');
          rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, [class*="cell"]'))
                              .map(c => c.innerText.trim());
            if (cells.length >= 2) results.push({ type: 'table_row', cells, equipment: eq, dataset: ds });
          });

          return results;
        }, DOM_SELECTORS, equipment, dataset);

        if (domData.length > 0) {
          captured.push({ source_url: url, data: domData, extraction_method: 'dom' });
        }
      }

      if (captured.length > 0) break;
      log.warning(`[${equipment}/${dataset}] No data captured on attempt ${attempt}, retrying...`);
      await sleep(5000 * attempt);

    } catch (err) {
      log.error(`[${equipment}/${dataset}] Error on attempt ${attempt}: ${err.message}`);
      await sleep(3000);
    } finally {
      await page.close().catch(() => {});
    }
  }

  return captured;
}

// ── Parse and normalize captured data ────────────────────────────────────────
function normalizeResults(captured, equipment, dataset, scrapedAt) {
  const records = [];

  for (const capture of captured) {
    const { data, source_url } = capture;

    // Handle array responses
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      // Try to extract standard fields regardless of DAT's schema name changes
      const rec = {
        equipment,
        dataset,
        scrapedAt,
        sourceUrl: source_url,
        raw: item,  // Always keep raw for debugging
      };

      // Map common field names DAT might use
      rec.stateCode        = item.stateCode       || item.state        || item.StateCode      || null;
      rec.periodStart      = item.periodStart      || item.weekStart    || item.date           || null;
      rec.rateUsd          = item.rateUsd          || item.rate         || item.perMilePrice   || item.spotRate || null;
      rec.loadCount        = item.loadCount        || item.loads        || item.loadVolume      || null;
      rec.truckCount       = item.truckCount       || item.trucks       || item.truckVolume     || null;
      rec.loadToTruckRatio = item.loadToTruckRatio || item.ltr          || item.ltRatio         || null;
      rec.fuelPriceGallon  = item.fuelPriceGallon  || item.fuelPrice    || item.dieselPrice     || null;
      rec.weekOverWeekPct  = item.weekOverWeekPct  || item.wow          || item.weeklyChangePct || null;

      records.push(rec);
    }
  }

  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────
await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  equipmentTypes = ['VAN', 'REEFER', 'FLATBED'],
  datasets       = ['national_rates', 'load_truck_ratio', 'state_rates'],
  headless       = true,
  maxRetries     = 3,
} = input;

const scrapedAt = new Date().toISOString();
const browser   = await launchBrowser(headless);
let totalRecords = 0;

try {
  // ── Scrape each equipment × dataset combination ──────────────────────────
  for (const equipment of equipmentTypes) {
    for (const dataset of datasets) {
      if (dataset === 'fuel_price') continue; // Handle separately below

      const urlMap = PAGE_URLS[equipment];
      if (!urlMap) {
        log.warning(`Unknown equipment type: ${equipment}`);
        continue;
      }

      const url = urlMap[dataset];
      if (!url) {
        log.warning(`No URL mapped for ${equipment}/${dataset}`);
        continue;
      }

      const captured = await scrapePage({ browser, url, equipment, dataset, maxRetries });
      const records  = normalizeResults(captured, equipment, dataset, scrapedAt);

      if (records.length > 0) {
        await Actor.pushData(records);
        totalRecords += records.length;
        log.info(`[${equipment}/${dataset}] Pushed ${records.length} records`);
      } else {
        // Push a diagnostic record so we know the page was reached but yielded no data
        await Actor.pushData([{
          equipment,
          dataset,
          scrapedAt,
          sourceUrl: url,
          error: 'No data extracted — page may require login or structure changed',
          raw: null,
        }]);
        log.warning(`[${equipment}/${dataset}] No records extracted`);
      }

      // Polite delay between pages
      await sleep(3000);
    }
  }

  // ── Fuel prices (shared across equipment types) ──────────────────────────
  if (datasets.includes('fuel_price')) {
    const fuelCaptured = await scrapePage({
      browser,
      url: FUEL_URL,
      equipment: 'ALL',
      dataset: 'fuel_price',
      maxRetries,
    });

    const fuelRecords = normalizeResults(fuelCaptured, 'ALL', 'fuel_price', scrapedAt);
    if (fuelRecords.length > 0) {
      await Actor.pushData(fuelRecords);
      totalRecords += fuelRecords.length;
      log.info(`[fuel_price] Pushed ${fuelRecords.length} records`);
    }
  }

  log.info(`Done. Total records pushed: ${totalRecords}`);

} finally {
  await browser.close();
  await Actor.exit();
}
