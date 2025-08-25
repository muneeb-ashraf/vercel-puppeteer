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
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    });

    const page = await browser.newPage();

    // Go to search page
    await page.goto('https://www.myfloridalicense.com/wl11.asp?mode=0&SID=', {
      waitUntil: 'networkidle2',
    });

    // Select search type
    if (licenseNumber) {
      await page.click('input[type="radio"][value="LicNbr"]');
    } else {
      await page.click('input[type="radio"][value="Name"]');
    }
    await page.click('button[name="SelectSearchType"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Fill out form
    if (licenseNumber) {
      await page.type('input[name="LicNbr"]', licenseNumber);
    } else {
      await page.type('input[name="OrgName"]', companyName);
    }

    await page.click('button[name="Search1"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Extract all company links from search results
    const results = await page.$$eval('a', (anchors) =>
      anchors
        .filter((a) => a.href && a.href.includes('prDetails.asp'))
        .map((a) => ({ name: a.textContent?.trim() || '', href: a.href }))
    );

    if (!results.length) {
      await browser.close();
      return res.status(404).json({ error: 'No results found.' });
    }

    let chosenLink: string | null = null;
    const searchQuery = (licenseNumber || companyName).toLowerCase();

    // Case-insensitive exact matches
    const exactMatches = results.filter((r) => r.name.toLowerCase() === searchQuery);

    if (exactMatches.length > 0) {
      chosenLink = exactMatches[0].href;
    } else {
      // Check for partial matches (case-insensitive)
      const partialMatches = results.filter((r) =>
        r.name.toLowerCase().includes(searchQuery)
      );

      if (partialMatches.length > 1) {
        await browser.close();
        return res.status(200).json({
          reviewRequired: true,
          message: 'Multiple close matches found. Manual review needed.',
          matches: partialMatches.map((m) => m.name),
        });
      } else if (partialMatches.length === 1) {
        chosenLink = partialMatches[0].href;
      } else {
        await browser.close();
        return res.status(404).json({ error: 'No exact or close matches found.' });
      }
    }

    // Visit company details page
    await page.goto(chosenLink, { waitUntil: 'networkidle2' });

    // Scrape company info (from v1)
    const data = await page.evaluate(() => {
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
      const primaryNameEl = nameElements.find((el) =>
        el.textContent?.includes('(Primary Name)')
      );
      if (primaryNameEl) {
        results['Primary Name'] = primaryNameEl.textContent
          ?.replace('(Primary Name)', '')
          .trim();
      }
      const dbaNameEl = nameElements.find((el) =>
        el.textContent?.includes('(DBA Name)')
      );
      if (dbaNameEl) {
        results['DBA Name'] = dbaNameEl.textContent
          ?.replace('(DBA Name)', '')
          .trim();
      }

      return results;
    });

    await browser.close();
    return res.status(200).json({ data });
  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}
