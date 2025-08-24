const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');

router.post('/scrape-company', async (req, res) => {
  const { companyName, licenseNumber } = req.body;
  if (!companyName && !licenseNumber) {
    return res.status(400).json({ error: 'Company name or license number required.' });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
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
    const companyLinks = await page.$$eval('a', (anchors, query, isLicense) => {
      return anchors
        .filter(a => isLicense ? a.textContent.trim() === query : a.textContent.trim() === query)
        .map(a => a.href);
    }, licenseNumber || companyName, !!licenseNumber);

    if (companyLinks.length === 0) {
      await browser.close();
      return res.status(404).json({ error: 'Company not found.' });
    }

    // Visit first exact match
    await page.goto(companyLinks[0], { waitUntil: 'networkidle2' });

    // Scrape all info (customize selectors as needed)
    const data = await page.evaluate(() => {
      // Example: get table data from company detail page
      const rows = Array.from(document.querySelectorAll('table tr'));
      const info = {};
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length === 2) {
          info[cells[0].textContent.trim()] = cells[1].textContent.trim();
        }
      });
      return info;
    });

    await browser.close();
    res.json({ data });
  } catch (err) {
    await browser.close();
    res.status(500).json({ error: err.toString() });
  }
});

module.exports = router;
