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

  // Get all anchor tags with company names
  const links = await page.$$eval('a', (anchors: HTMLAnchorElement[]) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const normalizedSearchName = normalizeCompanyName(companyName);

  // Look for exact matches (with or without comma)
  const exactMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    // Check if it's an exact match or exact match with comma variations
    return normalizedLinkText === normalizedSearchName ||
           normalizedLinkText === normalizedSearchName.replace(',', '') ||
           normalizedLinkText.replace(',', '') === normalizedSearchName;
  });

  // If exact match found, return the first one
  if (exactMatches.length > 0) {
    return exactMatches[0].href;
  }

  // Look for close matches (contains the search term)
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

async function scrapeCompanyDetails(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle2" });

  // Scrape company details from the searchResultDetail div
  const companyData = await page.evaluate(() => {
    const detailDiv = document.querySelector('.searchResultDetail');
    if (!detailDiv) return {};

    const results: { [key: string]: string } = {};
    
    // Find the Document Images span and its next table to exclude them
    const documentImagesSpan = Array.from(detailDiv.querySelectorAll('span'))
      .find(span => span.textContent?.trim() === 'Document Images');
    
    let documentImagesTable = null;
    if (documentImagesSpan) {
      // Find the next table element after the Document Images span
      let nextElement = documentImagesSpan.nextElementSibling;
      while (nextElement) {
        if (nextElement.tagName.toLowerCase() === 'table') {
          documentImagesTable = nextElement;
          break;
        }
        nextElement = nextElement.nextElementSibling;
      }
    }

    // Get all text content but exclude Document Images section
    const allElements = Array.from(detailDiv.querySelectorAll('*'));
    
    for (const element of allElements) {
      // Skip if this element is the Document Images span or its table
      if (element === documentImagesSpan || element === documentImagesTable) {
        continue;
      }
      
      // Skip if this element is inside the Document Images table
      if (documentImagesTable && documentImagesTable.contains(element)) {
        continue;
      }

      const text = element.textContent?.trim() || '';
      
      // Look for label-value pairs (typically in format "Label: Value" or in table cells)
      if (element.tagName.toLowerCase() === 'td' || 
          element.tagName.toLowerCase() === 'th' ||
          element.tagName.toLowerCase() === 'span' ||
          element.tagName.toLowerCase() === 'div') {
        
        // Check if this looks like a label (ends with colon)
        if (text.endsWith(':')) {
          const key = text.slice(0, -1).trim();
          let value = '';
          
          // Try to find the value in the next sibling
          if (element.nextElementSibling) {
            value = element.nextElementSibling.textContent?.trim() || '';
          }
          
          if (key && value) {
            results[key] = value;
          }
        }
        
        // Also check for patterns like "Label: Value" in a single element
        const colonIndex = text.indexOf(':');
        if (colonIndex > 0 && colonIndex < text.length - 1) {
          const key = text.substring(0, colonIndex).trim();
          const value = text.substring(colonIndex + 1).trim();
          
          if (key && value && key.length < 50) { // Reasonable key length
            results[key] = value;
          }
        }
      }
    }

    // Also extract any table data in a structured way
    const tables = Array.from(detailDiv.querySelectorAll('table'));
    tables.forEach((table, tableIndex) => {
      // Skip the Document Images table
      if (table === documentImagesTable) return;
      
      const rows = Array.from(table.querySelectorAll('tr'));
      rows.forEach((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length === 2) {
          // Two-column table, likely label-value pairs
          const key = cells[0].textContent?.trim().replace(':', '') || '';
          const value = cells[1].textContent?.trim() || '';
          if (key && value) {
            results[key] = value;
          }
        } else if (cells.length > 2 && rowIndex === 0) {
          // Multi-column table with headers
          const headers = cells.map(cell => cell.textContent?.trim() || '');
          // Store headers for potential use with subsequent rows
          results[`table_${tableIndex}_headers`] = headers.join('|');
        }
      });
    });

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

    const responseData = await scrapeCompanyDetails(page, result as string);
    
    await browser.close();
    return res.status(200).json({ data: responseData });

  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}