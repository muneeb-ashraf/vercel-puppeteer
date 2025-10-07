import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page } from 'puppeteer-core';
import { normalizeCompanyName } from "@/utils/normalizeCompanyName";

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

async function searchByCompanyName(page: Page, companyName: string) {
  const baseUrl = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
  
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  
  // Enter company name in search input
  await page.type('#SearchTerm', companyName);
  
  // Click search button
  await page.click('input[type="submit"][value="Search Now"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

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

  // --- MODIFICATION START ---
  // Filter out results where the document number starts with 'F' or 'M'
  const filteredResults = resultsFromPage.filter(result => {
    const docNum = result.documentNumber.toUpperCase();
    return !docNum.startsWith('F') && !docNum.startsWith('M');
  });
  // --- MODIFICATION END ---

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
  await page.goto(url, { waitUntil: "networkidle2" });
  
  // Get the raw HTML content of the page
  const htmlContent = await page.content();
  
  return htmlContent;
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

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });

    const page = await browser.newPage();
    
    const result = await searchByCompanyName(page, companyName);

    if (!result) {
      await browser.close();
      return res.status(404).json({ error: 'Company not found or all matches were filtered out.' });
    }

    if ((result as any).reviewNeeded) {
      await browser.close();
      return res.status(200).json({ review: (result as any).reviewNeeded.join(', ') });
    }

    // Fetch raw HTML instead of scraping details
    const htmlContent = await fetchCompanyPageHTML(page, result as string);
    
    await browser.close();
    return res.status(200).json({ 
      url: result,
      html: htmlContent 
    });

  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}
