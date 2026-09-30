/**
 * DAT Trendlines Freight Scraper v2
 *
 * DAT Trendlines is a SINGLE PAGE at dat.com/trendlines with:
 *   - National Spot Rates (Van/Reefer/Flatbed)
 *   - Load-to-Truck Ratio
 *   - Market Conditions Map
 * Equipment type is switched via a dropdown, not separate URLs.
 *
 * Strategy: Load the page once, intercept all JSON, switch equipment
 * types via dropdown clicks, capture data for each.
 */

import { Actor, log } from 'apify';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteerExtra.use(StealthPlugin());

const TRENDLINES_URL = 'https://www.dat.com/trendlines';
const EQUIPMENT_TYPES = ['Van', 'Reefer', 'Flatbed'];

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

async function saveScreenshot(page, key) {
  try {
    const buf = await page.screenshot({ fullPage: true });
    await Actor.setValue(key, buf, { contentType: 'image/png' });
    log.info(`📸 Screenshot saved: "${key}"`);
  } catch (e) {
    log.warning(`Screenshot failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  headless   = true,
  maxRetries = 3,
} = input;

const scrapedAt = new Date().toISOString();
const browser   = await launchBrowser(headless);
const allCapturedJson = [];
const allResponseUrls = [];

try {
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );

  // ── Intercept ALL responses from dat.com ────────────────────────────────
  page.on('response', async (response) => {
    const url    = response.url();
    const status = response.status();
    const ct     = response.headers()['content-type'] || '';

    if (url.includes('dat.com')) {
      allResponseUrls.push({ url, status, ct: ct.slice(0, 50) });
    }

    if (status >= 200 && status < 300 && ct.includes('json') && url.includes('dat.com')) {
      try {
        const body = await response.json();
        const s = JSON.stringify(body).toLowerCase();
        // Capture anything that looks like chart/freight data
        const isFreight = ['rate','load','truck','fuel','spot','linehaul','trend',
                           'series','datapoint','permile','ltr','volume','price',
                           'week','ratio','state','national','chart','van','reefer','flatbed']
                          .some(k => s.includes(k));
        if (isFreight) {
          log.info(`✅ Captured JSON: ${url.slice(0, 120)}`);
          allCapturedJson.push({ source_url: url, data: body, capturedAt: new Date().toISOString() });
        }
      } catch {}
    }
  });

  // ── Load the single trendlines page ─────────────────────────────────────
  log.info(`Navigating to: ${TRENDLINES_URL}`);
  await page.goto(TRENDLINES_URL, { waitUntil: 'networkidle2', timeout: 90_000 });

  const pageTitle = await page.title();
  const pageUrl   = page.url();
  log.info(`Page loaded — title: "${pageTitle}", url: ${pageUrl}`);

  // Wait for SPA to render charts
  await sleep(10000);

  // Scroll full page to trigger lazy content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2000);

  await saveScreenshot(page, 'initial-load');

  // ── Try switching equipment type via dropdown ───────────────────────────
  for (const eqType of EQUIPMENT_TYPES) {
    log.info(`Attempting to select equipment: ${eqType}`);
    try {
      // Try clicking dropdown/select elements containing the equipment name
      const clicked = await page.evaluate((eq) => {
        const allEls = document.querySelectorAll('button, select, option, [role="option"], [role="tab"], [class*="dropdown"], [class*="select"], [class*="toggle"], [class*="tab"], [class*="equipment"], a, span, div');
        let found = false;
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase() === eq.toLowerCase() || text.toLowerCase().includes(eq.toLowerCase())) {
            // Check if this looks like a clickable control
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const cls = el.className || '';
            if (tag === 'button' || tag === 'option' || tag === 'a' ||
                role === 'option' || role === 'tab' ||
                cls.includes('tab') || cls.includes('option') || cls.includes('select') ||
                cls.includes('dropdown') || cls.includes('toggle') || cls.includes('equipment')) {
              el.click();
              found = true;
              break;
            }
          }
        }
        // Fallback: click any element with exact text match
        if (!found) {
          for (const el of allEls) {
            if ((el.textContent || '').trim().toLowerCase() === eq.toLowerCase()) {
              el.click();
              found = true;
              break;
            }
          }
        }
        return found;
      }, eqType);

      if (clicked) {
        log.info(`Clicked "${eqType}" — waiting for data refresh`);
        await sleep(5000);
      } else {
        log.warning(`Could not find clickable element for "${eqType}"`);
      }
    } catch (e) {
      log.warning(`Error switching to ${eqType}: ${e.message}`);
    }
  }

  // ── Also try timeframe tabs (Week/Month/Year) ──────────────────────────
  for (const period of ['Month', 'Year']) {
    try {
      await page.evaluate((p) => {
        const els = document.querySelectorAll('button, [role="tab"], [class*="tab"], span');
        for (const el of els) {
          if ((el.textContent || '').trim().toLowerCase() === p.toLowerCase()) {
            el.click();
            break;
          }
        }
      }, period);
      await sleep(3000);
    } catch {}
  }

  await saveScreenshot(page, 'after-interactions');

  // ── Log all dat.com response URLs for debugging ─────────────────────────
  log.info(`Total dat.com responses seen: ${allResponseUrls.length}`);
  const jsonResponses = allResponseUrls.filter(r => r.ct.includes('json'));
  log.info(`JSON responses: ${jsonResponses.length}`);
  for (const r of allResponseUrls.slice(0, 30)) {
    log.info(`  [${r.status}] ${r.ct} | ${r.url.slice(0, 150)}`);
  }

  // ── DOM extraction as fallback ──────────────────────────────────────────
  log.info('Extracting visible page data via DOM...');
  const domData = await page.evaluate(() => {
    const results = {};
    const allText = document.body.innerText || '';

    // Grab page text snippet
    results.pageTextSnippet = allText.slice(0, 5000);

    // Extract dollar amounts (rates)
    const rates = [];
    const rateRe = /\$(\d+\.\d{2})/g;
    let m;
    while ((m = rateRe.exec(allText)) !== null) {
      const v = parseFloat(m[1]);
      if (v > 0.50 && v < 15.0) rates.push(v);
    }
    results.extractedRates = rates;

    // Extract ratio numbers
    const ratios = [];
    const ratioRe = /(\d+\.\d{1,2})\s*(?:to\s*1|loads?\s*per|l\/?t)/gi;
    while ((m = ratioRe.exec(allText)) !== null) {
      ratios.push(parseFloat(m[1]));
    }
    results.extractedRatios = ratios;

    // __NEXT_DATA__ payload
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try { results.nextData = JSON.parse(nd.textContent); } catch {}
    }

    // Inline script data
    const scripts = Array.from(document.querySelectorAll('script'));
    const inlineData = [];
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.length > 100 && txt.length < 50000 &&
          (txt.includes('rate') || txt.includes('load') || txt.includes('truck') ||
           txt.includes('series') || txt.includes('chart'))) {
        inlineData.push(txt.slice(0, 3000));
      }
    }
    results.inlineScripts = inlineData;

    // Table data
    const tableRows = [];
    document.querySelectorAll('table tbody tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
      if (cells.length >= 2) tableRows.push(cells);
    });
    results.tableRows = tableRows;

    return results;
  });

  // ── Push results ────────────────────────────────────────────────────────
  const records = [];

  // API-captured JSON
  for (const cap of allCapturedJson) {
    const items = Array.isArray(cap.data) ? cap.data : [cap.data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      records.push({
        scrapedAt,
        sourceUrl: cap.source_url,
        extractionMethod: 'api_intercept',
        raw: item,
        // Try to normalize common fields
        stateCode:        item.stateCode || item.state || item.StateCode || null,
        periodStart:      item.periodStart || item.weekStart || item.date || null,
        rateUsd:          item.rateUsd || item.rate || item.perMilePrice || item.spotRate || null,
        loadCount:        item.loadCount || item.loads || item.loadVolume || null,
        truckCount:       item.truckCount || item.trucks || item.truckVolume || null,
        loadToTruckRatio: item.loadToTruckRatio || item.ltr || item.ltRatio || null,
        fuelPriceGallon:  item.fuelPriceGallon || item.fuelPrice || item.dieselPrice || null,
      });
    }
  }

  // DOM extracted data
  if (domData) {
    records.push({
      scrapedAt,
      sourceUrl: TRENDLINES_URL,
      extractionMethod: 'dom',
      raw: domData,
    });
  }

  if (records.length > 0) {
    await Actor.pushData(records);
    log.info(`Pushed ${records.length} records (${allCapturedJson.length} from API, 1 DOM)`);
  } else {
    await Actor.pushData([{
      scrapedAt,
      sourceUrl: TRENDLINES_URL,
      error: 'No data extracted',
      responseUrlsSeen: allResponseUrls.length,
      jsonResponsesSeen: jsonResponses.length,
      sampleUrls: allResponseUrls.slice(0, 10),
    }]);
    log.warning('No records extracted');
  }

  await page.close();
  log.info(`Done. ${records.length} records pushed.`);

} finally {
  await browser.close();
  await Actor.exit();
}
