import { NextApiRequest, NextApiResponse } from 'next';
import { Page } from 'puppeteer-core';

// --- Response Helpers ---

function sendError(res: NextApiResponse, message: string, statusCode = 400) {
  res.status(statusCode).json({ status: 'error', message });
}

function sendSuccess(res: NextApiResponse, data: any, statusCode = 200) {
  res.status(statusCode).json({ status: 'success', ...data });
}

// --- Main Handler ---

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { companyName, licenseNumber } = req.body;

  if (!companyName && !licenseNumber) {
    return sendError(res, 'Company name or license number required.');
  }

  let browser = null;
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = await import('puppeteer-core');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });

    const page = await browser.newPage();

    if (companyName && licenseNumber) {
        await handleCombinedSearch(page, res, companyName, licenseNumber);
    } else if (companyName) {
        await handleNameSearch(page, res, companyName);
    } else if (licenseNumber) {
        await handleLicenseSearch(page, res, licenseNumber);
    }

  } catch (err) {
    console.error(err);
    const error = err instanceof Error ? err.message : String(err);
    return sendError(res, `An unexpected error occurred: ${error}`, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// --- Core Logic ---

async function performSearch(page: Page, searchType: 'Name' | 'LicNbr', searchTerm: string) {
    await page.goto('https://www.myfloridalicense.com/wl11.asp?mode=0&SID=', { waitUntil: 'networkidle2' });
    await page.click(`input[type="radio"][value="${searchType}"]`);
    await page.click('button[name="SelectSearchType"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const inputName = searchType === 'Name' ? 'OrgName' : 'LicNbr';
    await page.type(`input[name="${inputName}"]`, searchTerm);
    await page.click('button[name="Search1"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
}

async function scrapeCompanyDetails(page: Page): Promise<any> {
    return page.evaluate(() => {
        const results: { [key: string]: any } = {};
        const allTds = Array.from(document.querySelectorAll('td'));
        for (let i = 0; i < allTds.length; i++) {
            let keyText = allTds[i].textContent?.trim() || '';
            if (keyText.endsWith(':')) {
                const key = keyText.slice(0, -1).trim();
                if (i + 1 < allTds.length) {
                    const value = allTds[i + 1].textContent?.trim() || '';
                    if (key && (value || !results[key])) results[key] = value;
                }
            }
        }
        const nameElements = Array.from(document.querySelectorAll('font b'));
        const primaryNameEl = nameElements.find(el => el.textContent?.includes('(Primary Name)'));
        if (primaryNameEl) results['Primary Name'] = primaryNameEl.textContent?.replace('(Primary Name)', '').trim();
        const dbaNameEl = nameElements.find(el => el.textContent?.includes('(DBA Name)'));
        if (dbaNameEl) results['DBA Name'] = dbaNameEl.textContent?.replace('(DBA Name)', '').trim();
        return results;
    });
}

function normalizeName(name: string): string {
    if (!name) return '';
    return name.toLowerCase().replace(/\s+/g, ' ').replace(/( inc| llc| ltd| co)\.?$/g, '').trim();
}

async function searchByName(page: Page, companyName: string): Promise<{ type: 'details', data: any } | { type: 'matches', data: any[] } | { type: 'not_found' }> {
    await performSearch(page, 'Name', companyName);
    const searchResults = await page.$$eval('a', (anchors) =>
      anchors
        .filter(a => a.href.includes('licensenum=') && a.textContent)
        .map(a => ({ name: a.textContent!.trim(), href: a.href }))
    );
    if (searchResults.length === 0) return { type: 'not_found' };

    const exactMatch = searchResults.find(r => normalizeName(r.name) === normalizeName(companyName));
    if (exactMatch) {
        await page.goto(exactMatch.href, { waitUntil: 'networkidle2' });
        const details = await scrapeCompanyDetails(page);
        return { type: 'details', data: details };
    }
    return { type: 'matches', data: searchResults };
}

async function searchByLicense(page: Page, licenseNumber: string): Promise<{ type: 'details', data: any } | { type: 'not_found' }> {
    await performSearch(page, 'LicNbr', licenseNumber);
    const searchResults = await page.$$eval('a', (anchors) =>
      anchors
        .filter(a => a.href.includes('licensenum=') && a.textContent)
        .map(a => ({ text: a.textContent!.trim(), href: a.href }))
    );
    if (searchResults.length === 0) return { type: 'not_found' };

    const exactMatch = searchResults.find(r => r.text === licenseNumber);
    if (exactMatch) {
        await page.goto(exactMatch.href, { waitUntil: 'networkidle2' });
        const details = await scrapeCompanyDetails(page);
        return { type: 'details', data: details };
    }
    return { type: 'not_found' };
}

// --- API Route Handlers ---

async function handleNameSearch(page: Page, res: NextApiResponse, companyName: string) {
    const result = await searchByName(page, companyName);
    if (result.type === 'details') {
        return sendSuccess(res, { company: result.data['Primary Name'] || result.data['DBA Name'], license_number: result.data['License Number'], details: result.data });
    }
    if (result.type === 'matches') {
        return sendSuccess(res, { message: "Multiple close matches found. Please review and select one.", results: result.data });
    }
    return sendError(res, 'Company not found.', 404);
}

async function handleLicenseSearch(page: Page, res: NextApiResponse, licenseNumber: string) {
    const result = await searchByLicense(page, licenseNumber);
    if (result.type === 'details') {
        return sendSuccess(res, { company: result.data['Primary Name'] || result.data['DBA Name'], license_number: result.data['License Number'], details: result.data });
    }
    return sendError(res, 'License number not found.', 404);
}

async function handleCombinedSearch(page: Page, res: NextApiResponse, companyName: string, licenseNumber: string) {
    const licenseResult = await searchByLicense(page, licenseNumber);
    if (licenseResult.type === 'not_found') {
        return sendError(res, `No company found for license number: ${licenseNumber}`);
    }

    const nameFromLicense = licenseResult.data['Primary Name'] || licenseResult.data['DBA Name'];
    if (normalizeName(nameFromLicense) === normalizeName(companyName)) {
        return sendSuccess(res, { company: nameFromLicense, license_number: licenseResult.data['License Number'], details: licenseResult.data });
    }

    // As a fallback, check the name search as well
    const nameResult = await searchByName(page, companyName);
    if (nameResult.type === 'details') {
        const nameFromNameSearch = nameResult.data['Primary Name'] || nameResult.data['DBA Name'];
        if (normalizeName(nameFromNameSearch) === normalizeName(nameFromLicense)) {
            return sendSuccess(res, { company: nameFromLicense, license_number: licenseResult.data['License Number'], details: licenseResult.data });
        }
    }

    return sendError(res, `Provided company name '${companyName}' and the name found for license '${licenseNumber}' ('${nameFromLicense}') do not match.`);
}
