import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page, Browser } from 'puppeteer-core';
import { normalizeCompanyName, getAndAmpersandVariant } from "@/utils/normalizeCompanyName";

// -------------------
// Configuration
// -------------------
const MAX_ATTEMPTS = 4; // Total attempts within the 5-minute window
const ATTEMPT_TIMEOUT = 60000; // 60 seconds per attempt
const BROWSER_LAUNCH_TIMEOUT = 15000; // 15 seconds to launch browser

// -------------------
// Stealth Configuration
// -------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
];

const SUNBIZ_BY_NAME_URL = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
const SEARCH_RESULTS_SELECTOR = '#search-results tbody tr';
const SEARCH_INPUT_SELECTOR = '#SearchTerm, input[name="SearchTerm"]';

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

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
  return page.$$eval(SEARCH_RESULTS_SELECTOR, (rows: HTMLTableRowElement[]) => {
    const results = [];
    for (const row of rows.slice(0, 5)) {
      const nameCell = row.querySelector('td:first-child');
      const docNumCell = row.querySelector('td:nth-child(2)');
      const statusCell = row.querySelector('td:nth-child(3)');

      const link = nameCell?.querySelector('a');
      const text = link?.textContent?.trim() || '';
      const href = link?.href || '';
      const documentNumber = docNumCell?.textContent?.trim() || '';
      const status = statusCell?.textContent?.trim() || '';

      if (text && href && documentNumber) {
        results.push({ text, href, documentNumber, status });
      }
    }
    return results;
  });
}

async function searchByCompanyName(page: Page, companyName: string) {
  const searchName = companyName.replace(/\//g, '');
  const resultsUrl = `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults/EntityName/${encodeURIComponent(searchName)}/Page1`;
  
  await page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForSunbizContent(page);
  
  let resultsFromPage = await readResultRows(page);

  if (resultsFromPage.length === 0) {
    await page.goto(SUNBIZ_BY_NAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSunbizContent(page);
    await page.type(SEARCH_INPUT_SELECTOR, searchName);
    await page.click('input[type="submit"][value="Search Now"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSunbizContent(page);
    resultsFromPage = await readResultRows(page);
  }

  // Filter to *include* only doc numbers starting with the specified letters
  // AND document number length must be MORE than 6 characters
  const allowedStarters = 'BDLMNTRP';
  const filteredResults = resultsFromPage.filter(result => {
    const docNum = result.documentNumber.toUpperCase();
    if (docNum.length === 0) {
      return false; // Exclude if no document number
    }
    
    // Skip if document number is 6 characters or less
    if (docNum.length <= 6) {
      return false;
    }
    
    const firstLetter = docNum[0];
    return allowedStarters.includes(firstLetter);
  });

  const normalizedSearchName = normalizeCompanyName(companyName);

  // Collect all exact name matches
  const exactMatches = filteredResults.filter(result => {
    const normalizedResultText = normalizeCompanyName(result.text);
    return normalizedResultText === normalizedSearchName ||
           normalizedResultText === normalizedSearchName.replace(',', '') ||
           normalizedResultText.replace(',', '') === normalizedSearchName;
  });

  if (exactMatches.length === 1) {
    return exactMatches[0].href;
  }

  // Multiple exact matches — prefer the Active one
  if (exactMatches.length > 1) {
    const activeMatch = exactMatches.find(r => r.status.toLowerCase() === 'active');
    return (activeMatch || exactMatches[0]).href;
  }

  // If no exact match is found, look for close matches within the filtered list
  const closeMatches = filteredResults.filter(result => {
    const normalizedResultText = normalizeCompanyName(result.text);
    return normalizedResultText.includes(normalizedSearchName) ||
           normalizedSearchName.includes(normalizedResultText);
  });

  // If close matches are found, return their names for manual review
  if (closeMatches.length > 0) {
    return { reviewNeeded: closeMatches.map(l => l.text) };
  }

  return null; // No suitable match found
}

async function fetchCompanyPageHTML(page: Page, url: string): Promise<string> {
  // Navigate to the URL
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || '';
    return document.body && !bodyText.includes('Enable JavaScript and cookies to continue');
  }, { timeout: 45000 }).catch(async () => {
    const diagnostics = await getPageDiagnostics(page);
    throw new Error(`Sunbiz detail page did not clear browser challenge. ${diagnostics}`);
  });

  // Get the raw HTML content of the page
  const htmlContent = await page.content();

  return htmlContent;
}

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
// Single Attempt Logic
// -------------------
async function attemptScrape(companyName: string): Promise<{
  success: boolean;
  data?: any;
  error?: string;
}> {
  let browser: Browser | null = null;
  
  try {
    // Launch browser with timeout
    browser = await launchBrowserWithTimeout();
    const page = await browser.newPage();

    // Set page timeout
    page.setDefaultTimeout(30000);
    await configurePage(page);

    // Search for company
    const result = await searchByCompanyName(page, companyName);

    if (!result) {
      await closeBrowserSafely(browser);
      return {
        success: false,
        error: 'Company not found or all matches were filtered out.'
      };
    }

    if ((result as any).reviewNeeded) {
      await closeBrowserSafely(browser);
      return {
        success: true,
        data: { review: (result as any).reviewNeeded.join(', ') }
      };
    }

    // Fetch raw HTML
    const htmlContent = await fetchCompanyPageHTML(page, result as string);
    
    await closeBrowserSafely(browser);
    
    return {
      success: true,
      data: { 
        url: result,
        html: htmlContent 
      }
    };

  } catch (error) {
    await closeBrowserSafely(browser);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage
    };
  }
}

// -------------------
// Retry Logic with Timeout
// -------------------
async function scrapeWithRetry(companyName: string): Promise<{
  success: boolean;
  data?: any;
  error?: string;
  attempts: number;
}> {
  const errors: string[] = [];
  
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Attempt ${attempt}/${MAX_ATTEMPTS} for company: ${companyName}`);
    
    try {
      // Wrap each attempt in a timeout
      const result: { success: boolean; data?: any; error?: string } = await Promise.race([
        attemptScrape(companyName),
        new Promise<{ success: boolean; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('Attempt timeout')), ATTEMPT_TIMEOUT)
        ),
      ]) as { success: boolean; data?: any; error?: string };

      if (result.success) {
        console.log(`Success on attempt ${attempt}`);
        return {
          success: true,
          data: result.data,
          attempts: attempt
        };
      }

      // Log the error and continue to next attempt
      errors.push(`Attempt ${attempt}: ${result.error}`);
      console.error(`Attempt ${attempt} failed:`, result.error);
      
      // Wait a bit before retrying (exponential backoff)
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Attempt ${attempt}: ${errorMessage}`);
      console.error(`Attempt ${attempt} threw error:`, errorMessage);
      
      // Wait before retrying
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All attempts failed
  return {
    success: false,
    error: `All ${MAX_ATTEMPTS} attempts failed. Errors: ${errors.join(' | ')}`,
    attempts: MAX_ATTEMPTS
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

  console.log(`Starting scrape request for: ${companyName}`);
  const startTime = Date.now();

  try {
    let result = await scrapeWithRetry(companyName);

    // If original name failed, try and/& variant
    if (!result.success) {
      const variant = getAndAmpersandVariant(companyName);
      if (variant) {
        console.log(`Retrying with and/& variant: "${variant}"`);
        const variantResult = await scrapeWithRetry(variant);
        if (variantResult.success) result = variantResult;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`Request completed in ${duration}ms after ${result.attempts} attempts`);

    if (result.success) {
      return res.status(200).json({
        ...result.data,
        meta: {
          attempts: result.attempts,
          duration
        }
      });
    } else {
      return res.status(500).json({
        error: result.error,
        meta: {
          attempts: result.attempts,
          duration
        }
      });
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Unexpected error in handler:', errorMessage);
    
    return res.status(500).json({
      error: `Unexpected error: ${errorMessage}`,
      meta: {
        duration
      }
    });
  }
}
