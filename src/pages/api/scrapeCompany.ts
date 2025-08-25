import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

async function searchByCompanyName(page: any, baseUrl: string, name: string) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.click('input[type="radio"][value="Name"]');
  await page.click('button[name="SelectSearchType"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  await page.type('input[name="OrgName"]', name);
  await page.click('button[name="Search1"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  const links = await page.$$eval('a', (anchors) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const normalizedName = normalize(name);

  const exactMatches = links.filter(l => normalize(l.text) === normalizedName);
  const closeMatches = links.filter(l => normalize(l.text).includes(normalizedName));

  if (exactMatches.length === 1) return exactMatches[0].href;
  if (exactMatches.length > 1) return exactMatches[0].href; // pick first
  if (closeMatches.length > 0) return { reviewNeeded: closeMatches.map(l => l.text) };

  return null;
}

async function searchByLicenseNumber(page: any, baseUrl: string, lic: string) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.click('input[type="radio"][value="LicNbr"]');
  await page.click('button[name="SelectSearchType"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  await page.type('input[name="LicNbr"]', lic);
  await page.click('button[name="Search1"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  const links = await page.$$eval('a', (anchors) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const exactMatches = links.filter(l => l.text.includes(lic));
  if (exactMatches.length === 1) return exactMatches[0].href;
  if (exactMatches.length > 1) return { reviewNeeded: exactMatches.map(l => l.text) };

  return null;
}

async function scrapeCompanyDetails(page: any, url: string) {
  await page.goto(url, { waitUntil: 'networkidle2' });
  return page.evaluate(() => {
    const results: { [key: string]: any } = {};
    const allTds = Array.from(document.querySelectorAll('td'));

    for (let i = 0; i < allTds.length; i++) {
      let keyText = allTds[i].textContent?.trim() || '';
      if (keyText.endsWith(':')) {
        const key = keyText.slice(0, -1).trim();
        if (i + 1 < allTds.length) {
          const value = allTds[i + 1].textContent?.trim() || '';
          if (key && (value || !results[key])) {
            results[key] = value;
          }
        }
      }
    }

    const nameElements = Array.from(document.querySelectorAll('font b'));
    const primaryNameEl = nameElements.find(el => el.textContent?.includes('(Primary Name)'));
    if (primaryNameEl) {
      results['Primary Name'] = primaryNameEl.textContent?.replace('(Primary Name)', '').trim();
    }
    const dbaNameEl = nameElements.find(el => el.textContent?.includes('(DBA Name)'));
    if (dbaNameEl) {
      results['DBA Name'] = dbaNameEl.textContent?.replace('(DBA Name)', '').trim();
    }

    return results;
  });
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

      const companyData = await scrapeCompanyDetails(page, companyResult as string);
      const licenseData = await scrapeCompanyDetails(page, licenseResult as string);

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
