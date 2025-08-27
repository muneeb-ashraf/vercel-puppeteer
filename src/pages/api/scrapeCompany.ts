import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page } from 'puppeteer-core';
import { normalizeCompanyName } from "@/utils/normalizeCompanyName";

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

async function searchByCompanyName(page: Page, baseUrl: string, name: string) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.click('input[type="radio"][value="Name"]');
  await page.click('button[name="SelectSearchType"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  await page.type('input[name="OrgName"]', name);
  await page.click('button[name="Search1"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  const links = await page.$$eval('a', (anchors: HTMLAnchorElement[]) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const normalizedName = normalizeCompanyName(name);

  const exactMatches = links.filter(
    l => normalizeCompanyName(l.text) === normalizedName
  );

  const closeMatches = links.filter(
    l => normalizeCompanyName(l.text).includes(normalizedName)
  );

  if (exactMatches.length === 1) return exactMatches[0].href;
  if (exactMatches.length > 1) return exactMatches[0].href; // pick first
  if (closeMatches.length > 0) return { reviewNeeded: closeMatches.map(l => l.text) };

  return null;
}

async function searchByLicenseNumber(page: Page, baseUrl: string, license: string) {
  // Normalize: uppercase only letters, keep numbers unchanged
  const normalizedLicense = license.replace(/[a-z]/g, c => c.toUpperCase());

  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.click('input[type="radio"][value="LicNbr"]'); // select license radio
  await page.click('button[name="SelectSearchType"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Type into license number field
  await page.type('input[name="LicNbr"]', normalizedLicense);
  await page.click('button[name="Search1"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Scrape all result rows and extract links properly
  const results = await page.$$eval('table tr', rows =>
    rows.map(row => {
      const link = row.querySelector('a');
      return {
        text: row.innerText.trim(),
        link: link ? link.href : null
      };
    }).filter(r => r.link) // Only keep rows that have links
  );

  // Match against normalized license number
  const matches = results.filter(r => r.text.includes(normalizedLicense));

  if (matches.length === 1 && matches[0].link) {
    return matches[0].link;
  }
  
  if (matches.length > 1) {
    // Find exact match first
    const exactMatch = matches.find(r => {
      const text = r.text.toUpperCase();
      return text.includes(normalizedLicense) && r.link;
    });
    
    if (exactMatch) {
      return exactMatch.link;
    }
    
    // If no exact match, return the first one with a link
    const firstWithLink = matches.find(r => r.link);
    if (firstWithLink) {
      return firstWithLink.link;
    }
    
    // If still no link found, return review needed with just the license numbers/names
    return { reviewNeeded: matches.map(r => r.text.split('\t')[1] || r.text).slice(0, 5) };
  }

  return { error: "License number not found." };
}








async function scrapeCompanyDetails(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle2" });

  // Check if we're on a search results page or a detail page
  const pageContent = await page.content();
  const isSearchResultsPage = pageContent.includes('Search Results') || pageContent.includes('License Type');
  
  let companyData: { [key: string]: string } = {};

  if (isSearchResultsPage) {
    // Handle search results page format
    companyData = await page.evaluate(() => {
      const results: { [key: string]: string } = {};
      
      // Try to extract data from the search results table
      const tableRows = Array.from(document.querySelectorAll('table tr'));
      
      for (const row of tableRows) {
        const text = (row as HTMLElement).innerText.trim();
        
        // Look for the data row with license info - more generic approach
        if (text.includes('\t') && (text.includes('Architect') || text.includes('Building') || text.includes('AR') || text.includes('CBC'))) {
          const parts = text.split('\t').filter(part => part.trim());
          
          if (parts.length >= 4) {
            results['License Type'] = parts[0] || '';
            results['Primary Name'] = parts[1] || '';
            results['Name Type'] = parts[2] || '';
            results['License Number'] = parts[3] || '';
            
            // Handle status and expiration which might be in parts[4] or separate
            if (parts[4]) {
              if (parts[4].includes('Current') || parts[4].includes('Active') || parts[4].includes('Inactive')) {
                results['Status'] = parts[4];
              }
            }
          }
        }
      }
      
      // Look for address information
      const addressMatch = document.body.innerText.match(/Main Address\*?:\s*([^\n\r]+)/i);
      if (addressMatch) {
        results['Main Address'] = addressMatch[1].trim();
      }
      
      // Look for expiration date
      const expirationMatch = document.body.innerText.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (expirationMatch) {
        results['Expires'] = expirationMatch[1];
      }
      
      return results;
    });
  } else {
    // Handle detailed profile page format (original logic)
    companyData = await page.evaluate(() => {
      const results: { [key: string]: string } = {};
      const allTds = Array.from(document.querySelectorAll("td"));

      for (let i = 0; i < allTds.length; i++) {
        let keyText = allTds[i].textContent?.trim() || "";
        if (keyText.endsWith(":")) {
          const key = keyText.slice(0, -1).trim();
          if (i + 1 < allTds.length) {
            const value = allTds[i + 1].textContent?.trim() || "";
            if (key && (value || !results[key])) {
              results[key] = value;
            }
          }
        }
      }

      return results;
    });
  }

  // Handle complaints - improved logic
  const complaintLink = await page.evaluate(() => {
    const anchor = Array.from(document.querySelectorAll("a")).find(a =>
      a.textContent?.toLowerCase().includes("view license complaint") ||
      a.textContent?.toLowerCase().includes("complaint")
    );
    return anchor ? (anchor as HTMLAnchorElement).href : null;
  });

  let complaints: any[] = [];
  if (complaintLink) {
    try {
      await page.goto(complaintLink, { waitUntil: "networkidle2" });

      complaints = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        let targetTable: HTMLTableElement | null = null;

        // Find the table that has a header row containing "Number" and "Class"
        for (const table of tables) {
          const headerText = table.innerText.toLowerCase();
          if (headerText.includes("number") && headerText.includes("class") && headerText.includes("incident")) {
            targetTable = table as HTMLTableElement;
            break;
          }
        }

        if (!targetTable) return [];

        const rows = Array.from(targetTable.querySelectorAll("tr"));
        const data: any[] = [];

        for (let i = 1; i < rows.length; i++) {  // skip header row
          const cells = Array.from(rows[i].querySelectorAll("td")).map(td =>
            td.textContent?.trim() || ""
          );

          // Only include actual complaint data, not navigation menu or header text
          if (cells.length > 1 && cells[0] && 
              !cells[0].includes('HOME') && 
              !cells[0].includes('ONLINE SERVICES') && 
              !cells[0].includes('SEARCH RESULTS') &&
              !cells[0].includes('Number') &&
              cells[0] !== 'Number') {
            
            data.push({
              number: cells[0] || "",
              class: cells[1] || "",
              incidentDate: cells[2] || "",
              status: cells[3] || "",
              disposition: cells[4] || "",
              dispositionDate: cells[5] || "",
              discipline: cells[6] || ""
            });
          }
        }

        return data;
      });
    } catch (error) {
      console.log('Could not fetch complaints:', error);
      complaints = [];
    }
  }

  return {
    ...companyData,
    complaints,
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

  const { companyName, licenseNumber } = req.body;
  if (!companyName && !licenseNumber) {
    return res.status(400).json({ error: 'Company name or license number required.' });
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
    const baseUrl = 'https://www.myfloridalicense.com/wl11.asp?mode=0&SID=';

    let responseData: any = null;

    if (companyName && !licenseNumber) {
      const result = await searchByCompanyName(page, baseUrl, companyName);

      if (!result) return res.status(404).json({ error: 'Company not found.' });
      if ((result as any).reviewNeeded) {
        return res.status(200).json({ review: (result as any).reviewNeeded });
      }
      responseData = await scrapeCompanyDetails(page, result as string);
    }


    
    if (licenseNumber && !companyName) {
  const result = await searchByLicenseNumber(page, baseUrl, licenseNumber);

  if (!result) return res.status(404).json({ error: 'License number not found.' });
  if ((result as any).reviewNeeded) {
    return res.status(200).json({ review: (result as any).reviewNeeded });
  }
  if ((result as any).message) {
    return res.status(200).json(result);
  }
responseData = await scrapeCompanyDetails(page, result as string);
}





    if (companyName && licenseNumber) {
      const companyResult = await searchByCompanyName(page, baseUrl, companyName);
      const licenseResult = await searchByLicenseNumber(page, baseUrl, licenseNumber);

      if (!companyResult || !licenseResult) {
        return res.status(404).json({ error: 'Not found.' });
      }

      if ((companyResult as any).reviewNeeded || (licenseResult as any).reviewNeeded) {
        return res.status(200).json({ error: 'Review needed due to multiple results.' });
      }

      const companyData = await scrapeCompanyDetails(page, companyResult as string) as Record<string, any>;
      const licenseData = await scrapeCompanyDetails(page, licenseResult as string) as Record<string, any>;

      const name1 = normalize(companyData['Primary Name'] || '');
      const name2 = normalize(licenseData['Primary Name'] || '');


      if (!name1 || !name2) {
        return res.status(404).json({ error: 'Not found.' });
      }

      if (name1 === name2 || name1.includes(name2) || name2.includes(name1)) {
        responseData = licenseData; // prefer license data
      } else {
        return res.status(200).json({ error: 'Provided company name and license number do not match.' });
      }
    }

    await browser.close();
    return res.status(200).json({ data: responseData });

  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}