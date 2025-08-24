import { NextApiRequest, NextApiResponse } from 'next';

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
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = await import('puppeteer-core');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });

    const page = await browser.newPage();

    // Go to search page
    await page.goto('https://www.myfloridalicense.com/wl11.asp?mode=0&SID=', { waitUntil: 'networkidle2' });

    // Select search type
    if (licenseNumber) {
      await page.click('input[type="radio"][value="LicNbr"]');
    } else {
      await page.click('input[type="radio"][value="Name"]');
    }

    await page.click('button[name="SelectSearchType"]');

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Fill out form
    if (licenseNumber) {
      await page.type('input[name="LicNbr"]', licenseNumber);
    } else {
      await page.type('input[name="OrgName"]', companyName);
    }

    await page.click('button[name="Search1"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Scrape results
    const companySelector = licenseNumber
      ? `a:contains("${licenseNumber}")`
      : `a:contains("${companyName}")`;

    // Evaluate page to find exact match (pseudo-selector, replace with actual logic)
    const companyLinks = await page.$$eval('a', (anchors: HTMLAnchorElement[], query: string, isLicense: boolean) => {
      return anchors
        .filter(a => a.textContent && a.textContent.trim() === query)
        .map(a => a.href);
    }, licenseNumber || companyName, !!licenseNumber);

    if (companyLinks.length === 0) {
      if (browser) {
        await browser.close();
      }
      return res.status(404).json({ error: 'Company not found.' });
    }

    // Visit first exact match
    await page.goto(companyLinks[0], { waitUntil: 'networkidle2' });

    // Return the HTML for debugging the scraper
    const html = await page.content();

    await browser.close();
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    if (browser) {
      await browser.close();
    }
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
}
