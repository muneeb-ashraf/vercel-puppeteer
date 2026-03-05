import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page, Browser } from 'puppeteer-core';

// -------------------
// Configuration
// -------------------
const MAX_ATTEMPTS = 2; // 2 attempts to stay within 60s limit
const ATTEMPT_TIMEOUT = 25000; // 25 seconds per attempt
const BROWSER_LAUNCH_TIMEOUT = 15000; // 15 seconds
const MIN_COMPANY_NAME_LENGTH = 3;
const TARGET_URL = 'https://dwcdataportal.fldfs.com/ProofOfCoverage.aspx';

// -------------------
// Type Definitions
// -------------------
interface WorkersCompData {
  success: boolean;
  data?: {
    tbody?: string;
    message?: string;
    companyName: string;
  };
  error?: string;
  meta: {
    duration: number;
    attempts: number;
  };
}

interface ScrapeResult {
  success: boolean;
  data?: {
    tbody?: string;
    message?: string;
  };
  error?: string;
}

// -------------------
// Helper Functions
// -------------------

/**
 * Try multiple selectors and return the first one that exists
 */
async function findSelector(
  page: Page,
  selectors: string[],
  fieldName: string
): Promise<string> {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        console.log(`[WORKERS_COMP] Found ${fieldName} using selector: ${selector}`);
        return selector;
      }
    } catch (error) {
      // Continue to next selector
    }
  }
  throw new Error(`Could not find ${fieldName} - tried ${selectors.length} selectors`);
}

/**
 * Extract results from the page (tbody HTML or "No Policy Current" message)
 */
async function extractResults(page: Page): Promise<{ tbody?: string; message?: string }> {
  // Check for "No Policy Current" message first
  const noResultsSelectors = [
    '#ContentPlaceHolder1_lblNotFound2',
    'span[id*="lblNotFound"]',
    'span[id*="NotFound"]'
  ];

  for (const selector of noResultsSelectors) {
    try {
      const noResultsElement = await page.$(selector);
      if (noResultsElement) {
        const messageText = await page.evaluate(el => el?.textContent, noResultsElement);
        if (messageText?.includes('No Policy Current')) {
          console.log('[WORKERS_COMP] Found "No Policy Current" message');
          return { message: 'No Policy Current' };
        }
      }
    } catch (error) {
      // Continue checking other selectors
    }
  }

  // Try to find the data table
  const tbodyHTML = await page.evaluate(() => {
    const table = document.querySelector('table.DataGrid_POC');
    if (table) {
      const tbody = table.querySelector('tbody');
      return tbody ? tbody.outerHTML : null;
    }
    return null;
  });

  if (tbodyHTML) {
    console.log('[WORKERS_COMP] Successfully extracted tbody HTML');
    return { tbody: tbodyHTML };
  }

  throw new Error('Results page loaded but no data table or "no results" message found');
}

// -------------------
// Browser Management
// -------------------
async function launchBrowserWithTimeout(): Promise<Browser> {
  return Promise.race([
    puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    }),
    new Promise<Browser>((_, reject) =>
      setTimeout(() => reject(new Error('Browser launch timeout')), BROWSER_LAUNCH_TIMEOUT)
    ),
  ]);
}

async function closeBrowserSafely(browser: Browser | null): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.error('[WORKERS_COMP] Error closing browser:', error);
    }
  }
}

// -------------------
// Single Attempt Logic
// -------------------
async function attemptScrape(companyName: string): Promise<ScrapeResult> {
  let browser: Browser | null = null;

  try {
    // Launch browser with timeout
    console.log('[WORKERS_COMP] Launching browser...');
    browser = await launchBrowserWithTimeout();
    const page = await browser.newPage();

    // Set page timeout
    page.setDefaultTimeout(30000);

    // Navigate to the form page
    console.log('[WORKERS_COMP] Navigating to:', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Define selector options for employer name field
    const employerNameSelectors = [
      '#ContentPlaceHolder1_txtEmployerName',
      'input[name*="EmployerName"]',
      'input[name*="Employer"]',
      'input[type="text"][id*="Employer"]',
      'input[type="text"][name*="txt"]'
    ];

    // Find and fill employer name field
    const employerFieldSelector = await findSelector(page, employerNameSelectors, 'employer name field');
    console.log('[WORKERS_COMP] Typing company name:', companyName);
    await page.type(employerFieldSelector, companyName, { delay: 50 });

    // Define selector options for search button
    const searchButtonSelectors = [
      '#ContentPlaceHolder1_btnSearch',
      'input[type="submit"][value*="Search"]',
      'button[id*="Search"]',
      'input[name*="btnSearch"]',
      'input[type="submit"][id*="btn"]'
    ];

    // Find and click search button
    const searchButtonSelector = await findSelector(page, searchButtonSelectors, 'search button');
    console.log('[WORKERS_COMP] Clicking search button');
    await page.click(searchButtonSelector);

    // Wait for results (either data table or no-results message)
    console.log('[WORKERS_COMP] Waiting for results...');
    await Promise.race([
      page.waitForSelector('table.DataGrid_POC', { timeout: 30000 }),
      page.waitForSelector('#ContentPlaceHolder1_lblNotFound2', { timeout: 30000 }),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]).catch(() => {
      // Ignore timeout - we'll check for results anyway
      console.log('[WORKERS_COMP] Wait completed (may have timed out, checking for results)');
    });

    // Additional wait for AJAX/UpdatePanel (ASP.NET pattern)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract results
    const results = await extractResults(page);

    await closeBrowserSafely(browser);

    return {
      success: true,
      data: results
    };

  } catch (error) {
    await closeBrowserSafely(browser);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[WORKERS_COMP] Attempt failed:', errorMessage);
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
    console.log(`[WORKERS_COMP] Attempt ${attempt}/${MAX_ATTEMPTS} for: "${companyName}"`);

    try {
      // Wrap each attempt in a timeout
      const result: ScrapeResult = await Promise.race([
        attemptScrape(companyName),
        new Promise<ScrapeResult>((_, reject) =>
          setTimeout(() => reject(new Error('Attempt timeout')), ATTEMPT_TIMEOUT)
        ),
      ]) as ScrapeResult;

      if (result.success) {
        console.log(`[WORKERS_COMP] Success on attempt ${attempt}`);
        return {
          success: true,
          data: result.data,
          attempts: attempt
        };
      }

      // Log the error and continue to next attempt
      errors.push(`Attempt ${attempt}: ${result.error}`);
      console.error(`[WORKERS_COMP] Attempt ${attempt} failed:`, result.error);

      // Wait before retrying (exponential backoff)
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1000; // 1 second delay between attempts
        console.log(`[WORKERS_COMP] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Attempt ${attempt}: ${errorMessage}`);
      console.error(`[WORKERS_COMP] Attempt ${attempt} threw error:`, errorMessage);

      // Wait before retrying
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1000;
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
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validate HTTP method
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: `Method ${req.method} Not Allowed`
    });
  }

  // Validate input
  const { companyName } = req.body;

  if (!companyName) {
    return res.status(400).json({
      success: false,
      error: 'Company name is required'
    });
  }

  if (typeof companyName !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Company name must be a string'
    });
  }

  const trimmedCompanyName = companyName.trim();

  if (trimmedCompanyName.length < MIN_COMPANY_NAME_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `Company name must be at least ${MIN_COMPANY_NAME_LENGTH} characters`
    });
  }

  console.log(`[WORKERS_COMP] Starting scrape request for: "${trimmedCompanyName}"`);
  const startTime = Date.now();

  try {
    const result = await scrapeWithRetry(trimmedCompanyName);

    const duration = Date.now() - startTime;
    console.log(`[WORKERS_COMP] Request completed in ${duration}ms after ${result.attempts} attempts`);

    if (result.success) {
      return res.status(200).json({
        success: true,
        data: {
          ...result.data,
          companyName: trimmedCompanyName,
          message: result.data?.tbody
            ? 'Workers\' Compensation coverage data found'
            : result.data?.message
        },
        meta: {
          duration,
          attempts: result.attempts
        }
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        meta: {
          duration,
          attempts: result.attempts
        }
      });
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[WORKERS_COMP] Unexpected error in handler:', errorMessage);

    return res.status(500).json({
      success: false,
      error: `Unexpected error: ${errorMessage}`,
      meta: {
        duration
      }
    });
  }
}
