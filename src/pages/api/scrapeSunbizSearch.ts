import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page, Browser } from 'puppeteer-core';

// -------------------
// Configuration
// -------------------
const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT = 40000; // 40 seconds per attempt
const BROWSER_LAUNCH_TIMEOUT = 15000;
const MAX_RESULTS = 10;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
];

const SUNBIZ_BY_NAME_URL = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
const SEARCH_RESULTS_SELECTOR = '#search-results tbody tr';
const SEARCH_INPUT_SELECTOR = '#SearchTerm, input[name="SearchTerm"]';

// -------------------
// Browser Management
// -------------------
async function launchBrowserWithTimeout(): Promise<Browser> {
  return Promise.race([
    puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
        '--window-size=1920,1080',
      ],
      executablePath: await chromium.executablePath(),
      headless: "shell",
    }),
    new Promise<Browser>((_, reject) =>
      setTimeout(() => reject(new Error('Browser launch timeout')), BROWSER_LAUNCH_TIMEOUT)
    ),
  ]);
}

async function configurePage(page: Page): Promise<void> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  await page.setUserAgent(userAgent);
  await page.setJavaScriptEnabled(true);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  // Mask webdriver detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
}

async function closeBrowserSafely(browser: Browser | null): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }
}

// -------------------
// Search Logic
// -------------------
async function getPageDiagnostics(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 220) || '';
    return `url=${location.href}; title=${document.title}; body=${bodyText}`;
  }).catch(error => `diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

async function waitForSunbizContent(page: Page): Promise<void> {
  try {
    await page.waitForSelector(`${SEARCH_RESULTS_SELECTOR}, ${SEARCH_INPUT_SELECTOR}`, { timeout: 45000 });
  } catch {
    const diagnostics = await getPageDiagnostics(page);
    throw new Error(`Sunbiz did not expose search results or form after browser load. ${diagnostics}`);
  }
}

async function readResultRows(page: Page) {
  return page.$$eval(
    SEARCH_RESULTS_SELECTOR,
    (rows: HTMLTableRowElement[], max: number) => {
      const parsed: { name: string; documentNumber: string; status: string; detailUrl: string }[] = [];
      for (const row of rows.slice(0, max)) {
        const nameCell = row.querySelector('td:first-child');
        const docNumCell = row.querySelector('td:nth-child(2)');
        const statusCell = row.querySelector('td:nth-child(3)');

        const link = nameCell?.querySelector('a');
        const name = link?.textContent?.trim() || '';
        const documentNumber = docNumCell?.textContent?.trim() || '';
        const status = statusCell?.textContent?.trim() || '';
        const detailUrl = link?.getAttribute('href') || '';

        if (name && documentNumber) {
          parsed.push({ name, documentNumber, status, detailUrl });
        }
      }
      return parsed;
    },
    MAX_RESULTS
  );
}

async function searchSunbiz(page: Page, companyName: string) {
  const searchName = companyName.replace(/\//g, '');
  const resultsUrl = `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults/EntityName/${encodeURIComponent(searchName)}/Page1`;

  await page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForSunbizContent(page);

  let results = await readResultRows(page);
  if (results.length > 0) return results;

  await page.goto(SUNBIZ_BY_NAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForSunbizContent(page);

  await page.type(SEARCH_INPUT_SELECTOR, searchName);
  await page.click('input[type="submit"][value="Search Now"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForSunbizContent(page);

  results = await readResultRows(page);
  return results;
}

// -------------------
// Single Attempt
// -------------------
async function attemptSearch(companyName: string) {
  let browser: Browser | null = null;

  try {
    browser = await launchBrowserWithTimeout();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await configurePage(page);

    const results = await searchSunbiz(page, companyName);
    await closeBrowserSafely(browser);

    return { success: true as const, data: results };
  } catch (error) {
    await closeBrowserSafely(browser);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false as const, error: errorMessage };
  }
}

// -------------------
// Retry Logic
// -------------------
async function searchWithRetry(companyName: string) {
  const errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[scrapeSunbizSearch] Attempt ${attempt}/${MAX_ATTEMPTS} for: ${companyName}`);

    try {
      const result = await Promise.race([
        attemptSearch(companyName),
        new Promise<{ success: false; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('Attempt timeout')), ATTEMPT_TIMEOUT)
        ),
      ]);

      if (result.success) {
        console.log(`[scrapeSunbizSearch] Success on attempt ${attempt}, found ${result.data.length} results`);
        return { success: true as const, data: result.data, attempts: attempt };
      }

      errors.push(`Attempt ${attempt}: ${result.error}`);
      console.error(`[scrapeSunbizSearch] Attempt ${attempt} failed:`, result.error);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Attempt ${attempt}: ${msg}`);
      console.error(`[scrapeSunbizSearch] Attempt ${attempt} threw:`, msg);
    }

    // Brief delay before retry
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return {
    success: false as const,
    error: `All ${MAX_ATTEMPTS} attempts failed. ${errors.join(' | ')}`,
    attempts: MAX_ATTEMPTS,
  };
}

// -------------------
// API Handler
// -------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { companyName } = req.body;
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  console.log(`[scrapeSunbizSearch] Starting search for: ${companyName}`);
  const startTime = Date.now();

  try {
    const result = await searchWithRetry(companyName);
    const duration = Date.now() - startTime;
    console.log(`[scrapeSunbizSearch] Completed in ${duration}ms after ${result.attempts} attempts`);

    if (result.success) {
      return res.status(200).json({
        results: result.data,
        meta: { attempts: result.attempts, duration },
      });
    } else {
      return res.status(500).json({
        error: result.error,
        meta: { attempts: result.attempts, duration },
      });
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[scrapeSunbizSearch] Unexpected error:', errorMessage);
    return res.status(500).json({
      error: `Unexpected error: ${errorMessage}`,
      meta: { duration },
    });
  }
}
