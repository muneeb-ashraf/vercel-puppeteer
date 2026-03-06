import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page, Browser } from 'puppeteer-core';

// -------------------
// Configuration
// -------------------
const MAX_ATTEMPTS = 2; // 2 attempts to stay within 60s limit
const ATTEMPT_TIMEOUT = 25000; // 25 seconds per attempt (increased to fit 3 scrapes)
const BROWSER_LAUNCH_TIMEOUT = 15000; // 15 seconds
const MIN_COMPANY_NAME_LENGTH = 3;
const PROOF_OF_COVERAGE_URL = 'https://dwcdataportal.fldfs.com/ProofOfCoverage.aspx';
const EXEMPTION_URL = 'https://dwcdataportal.fldfs.com/Exemption.aspx';
const INSURANCE_CLASS_CODE_BASE_URL = 'https://www.insurancexdate.com/classreport.php';

// -------------------
// Type Definitions
// -------------------
interface ClassCodeDetails {
  classCode: string;
  industry: string;
  phraseology: string;
  description: string;
  category: string;
}

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
    proofOfCoverage?: {
      tbody?: string;
      message?: string;
    };
    exemption?: {
      tbody?: string;
      message?: string;
    };
    classCodeDetails?: ClassCodeDetails | null;
  };
  error?: string;
  partialSuccess?: boolean;
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
 * Extract results from the page (tbody HTML or "No Policy Currently In Effect" message)
 */
async function extractResults(page: Page): Promise<{ tbody?: string; message?: string }> {
  // Check for "No Policy Currently In Effect" message first
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
        if (messageText?.includes('No Policy Currently In Effect')) {
          console.log('[WORKERS_COMP] Found "No Policy Currently In Effect" message');
          return { message: 'No Policy Currently In Effect' };
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

/**
 * Extract exemption results from the page (tbody HTML or "No record found" message)
 */
async function extractExemptionResults(page: Page): Promise<{ tbody?: string; message?: string }> {
  // Check for "No record found" message
  const noRecordElement = await page.$('#ContentPlaceHolder1_lblNotFound');
  if (noRecordElement) {
    const messageText = await page.evaluate(el => el?.textContent, noRecordElement);
    if (messageText?.includes('No record found')) {
      console.log('[WORKERS_COMP] Found "No record found" message for exemption');
      return { message: 'No record found' };
    }
  }

  // Extract table tbody
  const tbodyHTML = await page.evaluate(() => {
    const table = document.querySelector('table#ContentPlaceHolder1_DataGrid_Exemption');
    if (table) {
      const tbody = table.querySelector('tbody');
      return tbody ? tbody.outerHTML : null;
    }
    return null;
  });

  if (tbodyHTML) {
    console.log('[WORKERS_COMP] Successfully extracted exemption tbody HTML');
    return { tbody: tbodyHTML };
  }

  throw new Error('Exemption results page loaded but no data table or "no record found" message found');
}

/**
 * Extract the Governing Class Code from the Proof of Coverage tbody HTML
 */
function extractGoverningClassCode(tbodyHTML: string): string | null {
  try {
    console.log('[WORKERS_COMP] Attempting to extract Governing Class Code from tbody HTML');

    // Parse the tbody HTML to find the span containing the class code
    // The span has an ID pattern like: ContentPlaceHolder1_DataGrid_POC_Label9_0
    // Strategy: Look for spans with IDs matching this pattern
    const spanIdPattern = /ContentPlaceHolder1_DataGrid_POC_Label(\d+)_0/g;
    const matches = tbodyHTML.match(/<span[^>]*id="ContentPlaceHolder1_DataGrid_POC_Label\d+_0"[^>]*>([^<]+)<\/span>/);

    if (matches && matches[1]) {
      const classCode = matches[1].trim();
      console.log('[WORKERS_COMP] ✓ Found Governing Class Code:', classCode);
      return classCode;
    }

    // Fallback: Try to find by searching for the "Governing Class Code" header
    // and extracting the corresponding cell value
    if (tbodyHTML.includes('Governing Class Code')) {
      console.log('[WORKERS_COMP] Found "Governing Class Code" text in tbody, trying alternative extraction');

      // Look for span elements that might contain the class code (numeric pattern)
      const spanMatches = tbodyHTML.match(/<span[^>]*>(\d{5})<\/span>/g);
      if (spanMatches && spanMatches.length > 0) {
        // Extract the numeric value from the first match
        const match = spanMatches[0].match(/>(\d{5})</);
        if (match && match[1]) {
          const classCode = match[1].trim();
          console.log('[WORKERS_COMP] ✓ Found Governing Class Code (fallback):', classCode);
          return classCode;
        }
      }
    }

    console.log('[WORKERS_COMP] ✗ No Governing Class Code found in tbody HTML');
    console.log('[WORKERS_COMP] Debug: tbody preview:', tbodyHTML.substring(0, 500));
    return null;
  } catch (error) {
    console.error('[WORKERS_COMP] ✗ Error extracting Governing Class Code:', error);
    return null;
  }
}

/**
 * Scrape class code details from insurancexdate.com
 */
async function scrapeClassCodeDetails(
  page: Page,
  classCode: string
): Promise<ClassCodeDetails | null> {
  try {
    console.log('[WORKERS_COMP] ═══ Starting class code details scrape ═══');
    console.log('[WORKERS_COMP] Class code to search:', classCode);

    // Navigate to search page
    const searchUrl = `${INSURANCE_CLASS_CODE_BASE_URL}?search=${classCode}&state=FL`;
    console.log('[WORKERS_COMP] Navigating to:', searchUrl);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[WORKERS_COMP] ✓ Page loaded successfully');

    // Wait for results table
    await page.waitForSelector('#dataTableClassList', { timeout: 10000 });
    console.log('[WORKERS_COMP] ✓ Results table found');

    // Extract detail page URL from the fakelink span
    const detailPageUrl = await page.evaluate(() => {
      const table = document.querySelector('#dataTableClassList');
      if (!table) {
        console.log('Table #dataTableClassList not found');
        return null;
      }

      // Look for tbody rows
      const tbody = table.querySelector('tbody');
      if (!tbody) {
        console.log('tbody not found in table');
        return null;
      }

      // Get the first row
      const firstRow = tbody.querySelector('tr');
      if (!firstRow) {
        console.log('No rows found in tbody');
        return null;
      }

      // Find the span with class "fakelink" that has data-href attribute
      const fakelinkSpan = firstRow.querySelector('span.fakelink[data-href]');
      if (fakelinkSpan) {
        const dataHref = fakelinkSpan.getAttribute('data-href');
        if (dataHref) {
          // Construct full URL (data-href is relative)
          return window.location.origin + dataHref;
        }
      }

      // Fallback: Try to find any <a> tag (in case structure changes)
      const link = firstRow.querySelector('a[href]') as HTMLAnchorElement;
      if (link) {
        return link.href;
      }

      return null;
    });

    if (!detailPageUrl) {
      console.log('[WORKERS_COMP] ✗ No detail page URL found for class code');
      console.log('[WORKERS_COMP] Possible causes: No results, different HTML structure, or class code not found');
      return null;
    }

    console.log('[WORKERS_COMP] ✓ Found detail page URL:', detailPageUrl);
    console.log('[WORKERS_COMP] Navigating to detail page...');

    // Navigate to detail page
    await page.goto(detailPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[WORKERS_COMP] ✓ Detail page loaded');

    // Extract data from the detail page
    const details = await page.evaluate(() => {
      // Extract fields from the General section
      const extractFieldByLabel = (labelText: string): string => {
        const labels = Array.from(document.querySelectorAll('label, strong, b'));
        const label = labels.find(el => el.textContent?.includes(labelText));
        if (!label) return '';

        // Get the next sibling or parent's next sibling content
        let valueElement = label.nextElementSibling;
        if (!valueElement) {
          valueElement = label.parentElement?.nextElementSibling || null;
        }

        return valueElement?.textContent?.trim() || '';
      };

      return {
        classCode: extractFieldByLabel('Class Code'),
        industry: extractFieldByLabel('Industry'),
        phraseology: document.querySelector('h4')?.textContent?.trim() || '',
        description: document.querySelector('div:has(> p) p')?.textContent?.trim() || '',
        category: document.querySelector('h2')?.textContent?.trim() || ''
      };
    });

    console.log('[WORKERS_COMP] ✓ Successfully extracted class code details');
    console.log('[WORKERS_COMP] Details:', JSON.stringify(details, null, 2));
    console.log('[WORKERS_COMP] ═══ Class code scrape complete ═══');
    return details;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[WORKERS_COMP] ✗ Class code details scrape failed:', errorMessage);
    return null;
  }
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
// Scraping Functions
// -------------------

/**
 * Scrape Proof of Coverage data
 */
async function scrapeProofOfCoverage(page: Page, companyName: string): Promise<{ tbody?: string; message?: string }> {
  console.log('[WORKERS_COMP] Starting Proof of Coverage scrape');

  // Navigate to form
  await page.goto(PROOF_OF_COVERAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Find and fill employer name field
  const employerNameSelectors = [
    '#ContentPlaceHolder1_txtEmployerName',
    'input[name*="EmployerName"]',
    'input[name*="Employer"]',
    'input[type="text"][id*="Employer"]',
    'input[type="text"][name*="txt"]'
  ];
  const employerFieldSelector = await findSelector(page, employerNameSelectors, 'employer name field');
  await page.type(employerFieldSelector, companyName, { delay: 50 });

  // Find and click search button
  const searchButtonSelectors = [
    '#ContentPlaceHolder1_btnSearch',
    'input[type="submit"][value*="Search"]',
    'button[id*="Search"]',
    'input[name*="btnSearch"]',
    'input[type="submit"][id*="btn"]'
  ];
  const searchButtonSelector = await findSelector(page, searchButtonSelectors, 'search button');
  await page.click(searchButtonSelector);

  // Wait for results
  await Promise.race([
    page.waitForSelector('table.DataGrid_POC', { timeout: 30000 }),
    page.waitForSelector('#ContentPlaceHolder1_lblNotFound2', { timeout: 30000 }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
  ]).catch(() => {
    console.log('[WORKERS_COMP] Wait completed for Proof of Coverage');
  });

  // Wait for AJAX/UpdatePanel
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Extract results using existing extractResults() function
  return await extractResults(page);
}

/**
 * Scrape Exemption data
 */
async function scrapeExemption(page: Page, companyName: string): Promise<{ tbody?: string; message?: string }> {
  console.log('[WORKERS_COMP] Starting Exemption scrape');

  // Navigate to exemption form
  await page.goto(EXEMPTION_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Find and fill employer name field (same selectors as Proof of Coverage)
  const employerNameSelectors = [
    '#ContentPlaceHolder1_txtEmployerName',
    'input[name*="EmployerName"]',
    'input[name*="Employer"]',
    'input[type="text"][id*="Employer"]',
    'input[type="text"][name*="txt"]'
  ];
  const employerFieldSelector = await findSelector(page, employerNameSelectors, 'employer name field');
  await page.type(employerFieldSelector, companyName, { delay: 50 });

  // Find and click search button
  const searchButtonSelectors = [
    '#ContentPlaceHolder1_btnSearch',
    'input[type="submit"][value*="Search"]',
    'button[id*="Search"]',
    'input[name*="btnSearch"]',
    'input[type="submit"][id*="btn"]'
  ];
  const searchButtonSelector = await findSelector(page, searchButtonSelectors, 'search button');
  await page.click(searchButtonSelector);

  // Wait for results
  await Promise.race([
    page.waitForSelector('table#ContentPlaceHolder1_DataGrid_Exemption', { timeout: 30000 }),
    page.waitForSelector('#ContentPlaceHolder1_lblNotFound', { timeout: 30000 }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
  ]).catch(() => {
    console.log('[WORKERS_COMP] Wait completed for Exemption');
  });

  // Wait for AJAX/UpdatePanel
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Extract exemption results
  return await extractExemptionResults(page);
}

// -------------------
// Single Attempt Logic
// -------------------
async function attemptScrape(companyName: string): Promise<ScrapeResult> {
  let browser: Browser | null = null;

  try {
    // Launch browser once
    console.log('[WORKERS_COMP] Launching browser...');
    browser = await launchBrowserWithTimeout();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Initialize result containers
    let proofOfCoverageResult: { tbody?: string; message?: string } | undefined = undefined;
    let exemptionResult: { tbody?: string; message?: string } | undefined = undefined;
    let classCodeDetails: ClassCodeDetails | null = null;
    const errors: string[] = [];

    // Scrape Proof of Coverage (sequential, not parallel)
    try {
      proofOfCoverageResult = await scrapeProofOfCoverage(page, companyName);
      console.log('[WORKERS_COMP] Proof of Coverage scrape completed successfully');

      // If Proof of Coverage has data (not a message), try to extract and scrape class code
      if (proofOfCoverageResult && proofOfCoverageResult.tbody) {
        console.log('[WORKERS_COMP] ─── Proof of Coverage has data, attempting class code extraction ───');
        try {
          const classCode = extractGoverningClassCode(proofOfCoverageResult.tbody);
          if (classCode) {
            console.log('[WORKERS_COMP] ✓ Successfully extracted class code:', classCode);
            console.log('[WORKERS_COMP] ─── Beginning class code details scrape ───');
            classCodeDetails = await scrapeClassCodeDetails(page, classCode);
            if (classCodeDetails) {
              console.log('[WORKERS_COMP] ✓ Class code details scrape completed successfully');
            } else {
              console.log('[WORKERS_COMP] ✗ Class code details scrape returned null');
            }
          } else {
            console.log('[WORKERS_COMP] ✗ Could not extract class code from Proof of Coverage tbody');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[WORKERS_COMP] ✗ Class code details scrape failed:', errorMessage);
          errors.push(`Class Code Details: ${errorMessage}`);
          // Don't fail the entire request if class code scraping fails
        }
      } else {
        console.log('[WORKERS_COMP] ⊘ Skipping class code extraction (no tbody data in Proof of Coverage)');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WORKERS_COMP] Proof of Coverage scrape failed:', errorMessage);
      errors.push(`Proof of Coverage: ${errorMessage}`);
    }

    // Scrape Exemption
    try {
      exemptionResult = await scrapeExemption(page, companyName);
      console.log('[WORKERS_COMP] Exemption scrape completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WORKERS_COMP] Exemption scrape failed:', errorMessage);
      errors.push(`Exemption: ${errorMessage}`);
    }

    await closeBrowserSafely(browser);

    // Determine success status
    const hasProofData = proofOfCoverageResult !== undefined;
    const hasExemptionData = exemptionResult !== undefined;

    if (!hasProofData && !hasExemptionData) {
      // Both primary scrapes failed
      return {
        success: false,
        error: `Both scrapes failed. Errors: ${errors.join(' | ')}`
      };
    }

    if (hasProofData && hasExemptionData) {
      // Both primary scrapes succeeded
      return {
        success: true,
        data: {
          proofOfCoverage: proofOfCoverageResult,
          exemption: exemptionResult,
          classCodeDetails: classCodeDetails || null
        },
        partialSuccess: errors.length > 0 // Set partial if class code failed but others succeeded
      };
    }

    // Partial success - at least one primary scrape succeeded
    return {
      success: true,
      partialSuccess: true,
      data: {
        proofOfCoverage: proofOfCoverageResult,
        exemption: exemptionResult,
        classCodeDetails: classCodeDetails || null
      },
      error: errors.length > 0 ? `Partial success. Errors: ${errors.join(' | ')}` : undefined
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
  partialSuccess?: boolean;
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
          attempts: attempt,
          partialSuccess: result.partialSuccess
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
      const responseData: any = {
        success: true,
        data: {
          proofOfCoverage: result.data?.proofOfCoverage,
          exemption: result.data?.exemption,
          classCodeDetails: result.data?.classCodeDetails || null,
          companyName: trimmedCompanyName
        },
        meta: {
          duration,
          attempts: result.attempts
        }
      };

      // Add warning if partial success
      if (result.partialSuccess) {
        responseData.warning = 'Partial success - one or more scrapes failed';
        responseData.partialError = result.error;
      }

      return res.status(200).json(responseData);
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
