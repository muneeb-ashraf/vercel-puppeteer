import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page, Browser } from 'puppeteer-core';
import { normalizeCompanyName } from "@/utils/normalizeCompanyName";

// -------------------
// Configuration
// -------------------
const MAX_ATTEMPTS = 4; // Total attempts within the 5-minute window
const ATTEMPT_TIMEOUT = 60000; // 60 seconds per attempt
const BROWSER_LAUNCH_TIMEOUT = 15000; // 15 seconds to launch browser

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

async function searchByCompanyName(page: Page, companyName: string) {
  const baseUrl = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
  
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Enter company name in search input
  await page.type('#SearchTerm', companyName);
  
  // Click search button
  await page.click('input[type="submit"][value="Search Now"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  // Get details from the first 5 result rows, including the document number
  const resultsFromPage = await page.$$eval('#search-results tbody tr', (rows: HTMLTableRowElement[]) => {
    const results = [];
    // Process up to the first 5 rows found on the page
    for (const row of rows.slice(0, 5)) {
      const nameCell = row.querySelector('td:first-child');
      const docNumCell = row.querySelector('td:nth-child(2)');
      
      const link = nameCell?.querySelector('a');
      const text = link?.textContent?.trim() || '';
      const href = link?.href || '';
      const documentNumber = docNumCell?.textContent?.trim() || '';
      
      if (text && href && documentNumber) {
        results.push({ text, href, documentNumber });
      }
    }
    return results;
  });

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

  // Check the filtered results for an exact match
  for (const result of filteredResults) {
    const normalizedResultText = normalizeCompanyName(result.text);
    
    // Check for an exact match or an exact match with comma variations
    if (normalizedResultText === normalizedSearchName ||
        normalizedResultText === normalizedSearchName.replace(',', '') ||
        normalizedResultText.replace(',', '') === normalizedSearchName) {
      return result.href; // Return the href of the first exact match found
    }
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
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  
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
    const result = await scrapeWithRetry(companyName);
    
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
