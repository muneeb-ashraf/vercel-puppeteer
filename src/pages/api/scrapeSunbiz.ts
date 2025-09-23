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

  // Get the first 5 anchor tags with company names
  const links = await page.$$eval('a', (anchors: HTMLAnchorElement[]) =>
    anchors
      .map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
      .filter(link => link.text && link.href.includes('/Inquiry/CorporationSearch/SearchResultDetail')) // Filter only relevant company links
      .slice(0, 5) // Take only first 5 results
  );

  const normalizedSearchName = normalizeCompanyName(companyName);

  // Check first 5 results for exact matches
  for (const link of links) {
    const normalizedLinkText = normalizeCompanyName(link.text);
    
    // Check if it's an exact match or exact match with comma variations
    if (normalizedLinkText === normalizedSearchName ||
        normalizedLinkText === normalizedSearchName.replace(',', '') ||
        normalizedLinkText.replace(',', '') === normalizedSearchName) {
      return link.href;
    }
  }

  // If no exact match found in first 5, look for close matches
  const closeMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    return normalizedLinkText.includes(normalizedSearchName) ||
           normalizedSearchName.includes(normalizedLinkText);
  });

  // If close matches found, return them for review
  if (closeMatches.length > 0) {
    return { reviewNeeded: closeMatches.map(l => l.text) };
  }

  return null;
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
      return res.status(404).json({ error: 'Company not found in first 5 search results.' });
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