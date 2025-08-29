import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { normalizeCompanyName } from "@/utils/normalizeCompanyName";

interface ReviewData {
  reviewerName: string;
  rating: number;
  reviewText: string;
  reviewDate: string;
}

interface ScrapedData {
  success: boolean;
  companyName: string;
  overallRating?: number;
  reviews?: ReviewData[];
  message?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ScrapedData>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      companyName: '',
      message: 'Method not allowed. Use POST request.'
    });
  }

  const { companyName } = req.body;

  if (!companyName) {
    return res.status(400).json({
      success: false,
      companyName: '',
      message: 'Company name is required.'
    });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1980, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    // Go to Google US
    await page.goto('https://www.google.com/?gl=us&hl=en&pws=0&gws_rd=cr', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Handle cookie popup
    try {
      await page.waitForSelector('button[id*="accept"], button[id*="consent"]', { timeout: 3000 });
      await page.click('button[id*="accept"], button[id*="consent"]');
    } catch {}

    // Search company
    const normalizedCompanyName = normalizeCompanyName(companyName);
    await page.waitForSelector('textarea[name="q"]', { timeout: 10000 });
    await page.type('textarea[name="q"]', normalizedCompanyName, { delay: 100 });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    let rhsExists;
    try {
    rhsExists = await page.waitForSelector('#rhs', { timeout: 60000 });
    } catch {
    await browser.close();
    return res.status(200).json({
        success: false,
        companyName: normalizedCompanyName,
        message: 'Business is not registered in Google Maps and doesn\'t have a Google business profile.'
    });
    }


    // Click the Reviews link inside #rhs
    const reviewsLink = await page.$('#rhs a span.PbOY2e');
    if (!reviewsLink) {
      await browser.close();
      return res.status(200).json({
        success: false,
        companyName: normalizedCompanyName,
        message: 'Business has GBP card but no Reviews link found.'
      });
    }

    await reviewsLink.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Extract rating
    const overallRating = await page.evaluate(() => {
      const ratingEl = document.querySelector('g-review-stars span[aria-label]');
      if (!ratingEl) return 0;
      const label = ratingEl.getAttribute('aria-label') || '';
      const match = label.match(/Rated\s([\d.]+)\s*out of/i);
      return match ? parseFloat(match[1]) : 0;
    });

    // Extract reviews under div[data-attrid="kc:/local:all reviews"]
    const reviews: ReviewData[] = await page.evaluate(() => {
      const container = document.querySelector('div[data-attrid="kc:/local:all reviews"]');
      if (!container) return [];

      const reviewDivs = container.querySelectorAll('div');
      const extracted: ReviewData[] = [];

      reviewDivs.forEach(div => {
        const reviewerName = div.querySelector('.TSUbDb')?.textContent?.trim() || 'Anonymous';
        const ratingEl = div.querySelector('span[aria-label*="star"]');
        let rating = 0;
        if (ratingEl) {
          const match = ratingEl.getAttribute('aria-label')?.match(/(\d+(\.\d+)?)/);
          if (match) rating = parseFloat(match[0]);
        }
        const reviewText = div.querySelector('.Jtu6Td')?.textContent?.trim() || '';
        const reviewDate = div.querySelector('.dehysf, .AuVD')?.textContent?.trim() || '';

        if (reviewText) {
          extracted.push({ reviewerName, rating, reviewText, reviewDate });
        }
      });

      return extracted.slice(0, 5);
    });

    await browser.close();

    return res.status(200).json({
      success: true,
      companyName: normalizedCompanyName,
      overallRating,
      reviews
    });

  } catch (error) {
    console.error('Scraping error:', error);
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      companyName: companyName || '',
      message: `Error occurred while scraping: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
}
