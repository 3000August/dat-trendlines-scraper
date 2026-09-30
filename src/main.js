/**
 * DAT Trendlines Freight Scraper
 * Captures ALL network responses from DAT pages to find freight data,
 * with DOM fallback and screenshot debugging on failure.
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function looksLikeFreightData(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const s = JSON.stringify(obj).toLowerCase();
  return (
    s.includes('rate') ||
    s.includes('load') ||
    s.includes('truck') ||
    s.includes('ltr') ||
    s.includes('fuel') ||
    s.includes('state') ||
    s.includes('price') ||
    s.includes('spot') ||
    s.includes('linehaul') ||
    s.includes('volume') ||
    s.includes('week') ||
    s.includes('trend') ||
    s.includes('chart') ||
    s.includes('series') ||
    s.includes('datapoint') ||
    s.includes('permile')
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
  const allResponseUrls = []; // Log every response URL for debugging
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const page = await browser.newPage();

    try {
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      );

      // ── Intercept ALL responses — no URL filtering ──────────────────────
      page.on('response', async (response) => {
        const respUrl = response.url();
        const status  = response.status();
        const ct      = response.headers()['content-type'] || '';

        // Log every dat.com response for debugging
        if (respUrl.includes('dat.com')) {
          allResponseUrls.push({ url: respUrl, status, contentType: ct });
        }

        // Capture ANY JSON response from dat.com (no pattern filtering)
        if (status >= 200 && status < 300 && ct.includes('json') && respUrl.includes('dat.com')) {
          try {
            const body = await response.json();
            if (looksLikeFreightData(body)) {
              log.info(`[${equipment}/${dataset}] ✅ Captured JSON from: ${respUrl}`);
              captured.push({ source_url: respUrl, data: body });
            } else {
              log.info(`[${equipment}/${dataset}] ⏭️ JSON (not freight): ${respUrl}`);
            }
          } catch {
            // parse error — skip
          }
        }
      });

      log.info(`[${equipment}/${dataset}] Navigating to: ${url} (attempt ${attempt})`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 90_000 });

      // Check if we landed on the right page or got blocked
      const pageTitle = await page.title();
      const pageUrl   = page.url();
      log.info(`[${equipment}/${dataset}] Page loaded — title: "${pageTitle}", url: ${pageUrl}`);

      // Longer wait for SPA chart rendering
      await sleep(8000);

      // Scroll to trigger lazy-loaded charts
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(3000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(3000);

      // Click any "load more" or chart tab elements that might trigger data fetches
      try {
        await page.evaluate(() => {
          document.querySelectorAll('[class*="tab"], [class*="toggle"], [role="tab"]')
            .forEach(el => {
              try { el.click(); } catch {}
            });
        });
        await sleep(2000);
      } catch {}

      // Log all captured dat.com response URLs for debugging
      log.info(`[${equipment}/${dataset}] Total dat.com responses seen: ${allResponseUrls.length}`);
      for (const r of allResponseUrls.slice(0, 20)) {
        log.info(`  → [${r.status}] ${r.contentType.slice(0, 30)} | ${r.url.slice(0, 120)}`);
      }

      // ── DOM fallback ────────────────────────────────────────────────────
      if (captured.length === 0) {
        log.info(`[${equipment}/${dataset}] No API JSON captured, trying DOM extraction`);

        const domData = await page.evaluate((eq, ds) => {
          const results = [];
          const allText = document.body.innerText || '';

          // Extract any dollar amounts that look like freight rates
          const rateRe = /\$(\d+\.\d{2})/g;
          let m;
          while ((m = rateRe.exec(allText)) !== null) {
            const val = parseFloat(m[1]);
            if (val > 0.50 && val < 15.0) {
              results.push({ type: 'rate', value: val, equipment: eq, dataset: ds });
            }
          }

          // Extract ratio-like numbers near "load" or "truck" text
          const ltrRe = /(\d+\.\d{1,2})\s*(?:to\s*1|loads?\s*per|l\/?t)/gi;
          while ((m = ltrRe.exec(allText)) !== null) {
            results.push({ type: 'ltr', value: parseFloat(m[1]), equipment: eq, dataset: ds });
          }

          // Try any Highcharts/SVG chart data embedded in the page
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const txt = s.textContent || '';
            if (txt.includes('series') && (txt.includes('data') || txt.includes('point'))) {
              try {
                // Look for JSON-like structures in inline scripts
                const jsonMatch = txt.match(/\{[\s\S]*?"(?:series|data|chart)"[\s\S]*?\}/);
                if (jsonMatch) {
                  results.push({ type: 'script_data', raw: jsonMatch[0].slice(0, 2000), equipment: eq, dataset: ds });
                }
              } catch {}
            }
          }

          // Try __NEXT_DATA__ or similar SSR payloads
          const nextData = document.getElementById('__NEXT_DATA__');
          if (nextData) {
            try {
              const parsed = JSON.parse(nextData.textContent);
              results.push({ type: 'next_data', raw: parsed, equipment: eq, dataset: ds });
            } catch {}
          }

          // Try table rows
          const rows = document.querySelectorAll('table tbody tr, [class*="table"] [class*="row"]');
          rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, [class*="cell"]'))
                              .map(c => c.innerText.trim());
            if (cells.length >= 2) results.push({ type: 'table_row', cells, equipment: eq, dataset: ds });
          });

          // Grab the visible page text summary for analysis
          const snippet = allText.slice(0, 3000);
          results.push({ type: 'page_text_snippet', text: snippet, equipment: eq, dataset: ds });

          return results;
        }, equipment, dataset);

        if (domData.length > 0) {
          captured.push({ source_url: url, data: domData, extraction_method: 'dom' });
        }
      }

      // ── Screenshot on failure for debugging ─────────────────────────────
      if (captured.length === 0 || (captured.length === 1 && captured[0].extraction_method === 'dom')) {
        try {
          const screenshotBuf = await page.screenshot({ fullPage: true });
          const key = `debug-${equipment}-${dataset}-attempt${attempt}`.toLowerCase();
          await Actor.setValue(key, screenshotBuf, { contentType: 'image/png' });
          log.info(`[${equipment}/${dataset}] 📸 Screenshot saved as "${key}"`);
        } catch (e) {
          log.warning(`[${equipment}/${dataset}] Screenshot failed: ${e.message}`);
        }
      }

      if (captured.length > 0) break;
      log.warning(`[${equipment}/${dataset}] No data captured on attempt ${attempt}, retrying...`);
      await sleep(5000 * attempt);

    } catch (err) {
      log.error(`[${equipment}/${dataset}] Error on attempt ${attempt}: ${err.message}`);

      // Screenshot on error too
      try {
        const screenshotBuf = await page.screenshot({ fullPage: true });
        const key = `error-${equipment}-${dataset}-attempt${attempt}`.toLowerCase();
        await Actor.setValue(key, screenshotBuf, { contentType: 'image/png' });
      } catch {}

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
    const { data, source_url, extraction_method } = capture;

    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const rec = {
        equipment,
        dataset,
        scrapedAt,
        sourceUrl: source_url,
        extractionMethod: extraction_method || 'api',
        raw: item,
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
  for (const equipment of equipmentTypes) {
    for (const dataset of datasets) {
      if (dataset === 'fuel_price') continue;

      const urlMap = PAGE_URLS[equipment];
      if (!urlMap) { log.warning(`Unknown equipment: ${equipment}`); continue; }

      const url = urlMap[dataset];
      if (!url) { log.warning(`No URL for ${equipment}/${dataset}`); continue; }

      const captured = await scrapePage({ browser, url, equipment, dataset, maxRetries });
      const records  = normalizeResults(captured, equipment, dataset, scrapedAt);

      if (records.length > 0) {
        await Actor.pushData(records);
        totalRecords += records.length;
        log.info(`[${equipment}/${dataset}] Pushed ${records.length} records`);
      } else {
        await Actor.pushData([{
          equipment, dataset, scrapedAt, sourceUrl: url,
          error: 'No data extracted — page may require login or structure changed',
          raw: null,
        }]);
        log.warning(`[${equipment}/${dataset}] No records extracted`);
      }

      await sleep(3000);
    }
  }

  // ── Fuel prices ──────────────────────────────────────────────────────────
  if (datasets.includes('fuel_price')) {
    const fuelCaptured = await scrapePage({
      browser, url: FUEL_URL, equipment: 'ALL', dataset: 'fuel_price', maxRetries,
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
