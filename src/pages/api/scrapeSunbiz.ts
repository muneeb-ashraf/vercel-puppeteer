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
  
  // Enter company name in the search input
  await page.type('#SearchTerm', companyName);
  
  // Click the submit button
  await page.click('input[type="submit"][value="Search Now"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Get all anchor links from the search results
  const links = await page.$$eval('a', (anchors: HTMLAnchorElement[]) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const normalizedSearchName = normalizeCompanyName(companyName);

  // Find exact matches (with or without comma)
  const exactMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    // Check for exact match or exact match with comma variations
    return normalizedLinkText === normalizedSearchName ||
           normalizedLinkText === normalizedSearchName.replace(/,/g, '') ||
           normalizedLinkText.replace(/,/g, '') === normalizedSearchName;
  });

  if (exactMatches.length === 1) {
    return exactMatches[0].href;
  }

  // If no exact match or multiple exact matches, find close matches
  const closeMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    return normalizedLinkText.includes(normalizedSearchName) ||
           normalizedSearchName.includes(normalizedLinkText);
  });

  if (closeMatches.length > 0) {
    return { reviewNeeded: closeMatches.map(l => l.text) };
  }

  return null;
}

async function scrapeCompanyDetails(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle2" });

  // Extract company information from the searchResultDetail div
  const companyData = await page.evaluate(() => {
    const searchResultDetail = document.querySelector('.searchResultDetail');
    
    if (!searchResultDetail) {
      return null;
    }

    // Get all detailSection divs within searchResultDetail
    const detailSections = Array.from(searchResultDetail.querySelectorAll('.detailSection'));
    
    // Remove the second last detailSection (if it exists)
    if (detailSections.length >= 2) {
      const secondLastSection = detailSections[detailSections.length - 2];
      secondLastSection.remove();
    }

    // Remove the navigationBar div
    const navigationBar = searchResultDetail.querySelector('#navigationBar.navigationBar');
    if (navigationBar) {
      navigationBar.remove();
    }

    // Extract all text content and structure it
    const results: { [key: string]: string } = {};
    
    // Look for key-value pairs in table format or structured text
    const allElements = Array.from(searchResultDetail.querySelectorAll('*'));
    
    allElements.forEach((element, index) => {
      const text = element.textContent?.trim() || '';
      
      // Check if this looks like a label (ends with colon)
      if (text.endsWith(':') && text.length > 1) {
        const key = text.slice(0, -1).trim();
        
        // Try to find the next sibling or next element with content
        let nextElement = element.nextElementSibling;
        if (!nextElement && element.parentElement) {
          // If no next sibling, try the next element in the parent
          const parent = element.parentElement;
          const siblings = Array.from(parent.children);
          const currentIndex = siblings.indexOf(element);
          nextElement = siblings[currentIndex + 1];
        }
        
        if (nextElement) {
          const value = nextElement.textContent?.trim() || '';
          if (value && value !== key && !value.endsWith(':')) {
            results[key] = value;
          }
        }
      }
    });

    // Also extract table data if present
    const tables = searchResultDetail.querySelectorAll('table');
    tables.forEach(table => {
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length >= 2) {
          const key = cells[0].textContent?.trim() || '';
          const value = cells[1].textContent?.trim() || '';
          if (key && value && key.length > 0) {
            // Remove colon if present
            const cleanKey = key.endsWith(':') ? key.slice(0, -1) : key;
            results[cleanKey] = value;
          }
        }
      });
    });

    // If no structured data found, extract all visible text as a fallback
    if (Object.keys(results).length === 0) {
      const allText = searchResultDetail.textContent?.trim() || '';
      results['Raw Data'] = allText;
    }

    return results;
  });

  return companyData;
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
      return res.status(404).json({ error: 'Company not found.' });
    }

    if ((result as any).reviewNeeded) {
      await browser.close();
      return res.status(200).json({ review: (result as any).reviewNeeded.join(', ') });
    }

    const companyData = await scrapeCompanyDetails(page, result as string);

    if (!companyData) {
      await browser.close();
      return res.status(404).json({ error: 'Company details not found.' });
    }

    await browser.close();
    return res.status(200).json({ data: companyData });

  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}