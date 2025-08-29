import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page } from 'puppeteer-core';
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
  totalReviews?: number;
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
    // Launch Puppeteer with Vercel-compatible settings
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    
    // Set user agent to avoid detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    // Navigate to Google USA
    await page.goto('https://www.google.com/?gl=us&hl=en&pws=0&gws_rd=cr', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Handle cookie consent if present
    try {
      await page.waitForSelector('button[id*="accept"], button[id*="consent"]', { timeout: 3000 });
      await page.click('button[id*="accept"], button[id*="consent"]');
      await page.waitForTimeout(1000);
    } catch (e) {
      // Cookie consent not found, continue
    }

    // Search for the company
    const normalizedCompanyName = normalizeCompanyName(companyName);
    await page.waitForSelector('input[name="q"], textarea[name="q"]', { timeout: 10000 });
    await page.type('input[name="q"], textarea[name="q"]', normalizedCompanyName);
    await page.keyboard.press('Enter');

    // Wait for search results to load
    await page.waitForSelector('#search', { timeout: 15000 });

    // Check if there's a Google Business Profile card on the right side
    const gbpCardExists = await page.$('.kp-wholepage, .osrp-blk, div[data-async-context*="kp_wholepage"]');
    
    if (!gbpCardExists) {
      return res.status(200).json({
        success: false,
        companyName: normalizedCompanyName,
        message: 'Business is not registered in Google Maps and doesn\'t have a Google business profile.'
      });
    }

    // Extract basic business info and overall rating
    const businessInfo = await page.evaluate(() => {
      // Try multiple selectors for business name
      const nameSelectors = [
        'h2[data-attrid="title"]',
        '.qrShPb h2',
        '.kp-header h2',
        '.SPZz6b h2'
      ];
      
      let businessName = '';
      for (const selector of nameSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          businessName = element.textContent?.trim() || '';
          break;
        }
      }

      // Try multiple selectors for rating
      const ratingSelectors = [
        'span[data-attrid="kc:/collection/knowledge_panels/has_rating:rating"] span',
        '.Aq14fc',
        '.kp-header .AuVD'
      ];
      
      let overallRating = 0;
      for (const selector of ratingSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const ratingText = element.textContent?.trim();
          const rating = parseFloat(ratingText || '0');
          if (!isNaN(rating)) {
            overallRating = rating;
            break;
          }
        }
      }

      // Try to get total reviews count
      const reviewCountSelectors = [
        'span[data-attrid="kc:/collection/knowledge_panels/has_rating:num_ratings"]',
        '.AuVD span:last-child',
        '.hqzQac span'
      ];
      
      let totalReviews = 0;
      for (const selector of reviewCountSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const countText = element.textContent?.trim() || '';
          const match = countText.match(/[\d,]+/);
          if (match) {
            totalReviews = parseInt(match[0].replace(/,/g, ''));
            break;
          }
        }
      }

      return {
        businessName,
        overallRating,
        totalReviews
      };
    });

    // Look for and click on Reviews link/button
    const reviewsClickable = await Promise.race([
      page.waitForSelector('a[data-async-trigger="reviewDialog"], button[data-async-trigger="reviewDialog"]', { timeout: 5000 }).then(() => 'reviewDialog'),
      page.waitForSelector('a[href*="reviews"], span:contains("Reviews")', { timeout: 5000 }).then(() => 'reviewsLink'),
      page.waitForSelector('.review-dialog-list', { timeout: 2000 }).then(() => 'alreadyOpen'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
    ]);

    if (reviewsClickable === 'reviewDialog') {
      await page.click('a[data-async-trigger="reviewDialog"], button[data-async-trigger="reviewDialog"]');
      await page.waitForTimeout(3000);
    } else if (reviewsClickable === 'reviewsLink') {
      await page.click('a[href*="reviews"], span:contains("Reviews")');
      await page.waitForTimeout(3000);
    }

    // Extract reviews
    const reviews = await page.evaluate(() => {
      const reviewElements = document.querySelectorAll('.gws-localreviews__google-review, .jxjCjc, div[data-review-id]');
      const extractedReviews: ReviewData[] = [];

      for (let i = 0; i < Math.min(reviewElements.length, 5); i++) {
        const reviewElement = reviewElements[i];
        
        // Extract reviewer name
        const nameElement = reviewElement.querySelector('.TSUbDb a, .X5PpBb, .jBmLS');
        const reviewerName = nameElement?.textContent?.trim() || 'Anonymous';
        
        // Extract rating
        const ratingElement = reviewElement.querySelector('.lTi8oc, .Fam1ne .lTi8oc, [aria-label*="star"]');
        let rating = 0;
        if (ratingElement) {
          const ariaLabel = ratingElement.getAttribute('aria-label') || '';
          const ratingMatch = ariaLabel.match(/(\d+)\s*star/);
          if (ratingMatch) {
            rating = parseInt(ratingMatch[1]);
          }
        }
        
        // Extract review text
        const textElement = reviewElement.querySelector('.Jtu6Td, .K7oBsc, .MyEned');
        const reviewText = textElement?.textContent?.trim() || '';
        
        // Extract review date
        const dateElement = reviewElement.querySelector('.dehysf, .p2TkOb, .AuVD');
        const reviewDate = dateElement?.textContent?.trim() || '';

        if (reviewerName && (rating > 0 || reviewText)) {
          extractedReviews.push({
            reviewerName,
            rating,
            reviewText,
            reviewDate
          });
        }
      }
      
      return extractedReviews;
    });

    await browser.close();

    if (reviews.length === 0 && businessInfo.overallRating === 0) {
      return res.status(200).json({
        success: false,
        companyName: normalizedCompanyName,
        message: 'Business found but no reviews data could be extracted.'
      });
    }

    return res.status(200).json({
      success: true,
      companyName: businessInfo.businessName || normalizedCompanyName,
      overallRating: businessInfo.overallRating,
      totalReviews: businessInfo.totalReviews,
      reviews: reviews.slice(0, 5)
    });

  } catch (error) {
    console.error('Scraping error:', error);
    
    if (browser) {
      await browser.close();
    }

    return res.status(500).json({
      success: false,
      companyName: companyName || '',
      message: `Error occurred while scraping: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
}