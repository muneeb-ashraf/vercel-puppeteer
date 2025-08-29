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
      defaultViewport: { width: 1280, height: 720 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    
    // Set ignoreHTTPSErrors on the page instead
    await page.setRequestInterception(false);
    
    // Set user agent to avoid detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    // Navigate to Google USA
    await page.goto('https://www.google.com/?gl=us&hl=en&pws=0&gws_rd=cr', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Handle cookie consent if present
    try {
      await page.waitForSelector('button[id*="accept"], button[id*="consent"]', { timeout: 3000 });
      await page.click('button[id*="accept"], button[id*="consent"]');
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      // Cookie consent not found, continue
    }

    // Search for the company
    const normalizedCompanyName = normalizeCompanyName(companyName);
    await page.waitForSelector('input[name="q"]', { timeout: 10000 });
    await page.type('input[name="q"]', normalizedCompanyName, { delay: 100 });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Check if there's a Google Business Profile card on the right side
    // Wait a bit for dynamic content to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const gbpCardExists = await page.evaluate(() => {
      // Try multiple selectors for Google Business Profile cards
      const selectors = [
        '.kp-wholepage',
        '.osrp-blk',
        'div[data-async-context*="kp_wholepage"]',
        '.knowledge-panel',
        '.kp-header',
        '.SPZz6b',
        '[data-attrid="title"]',
        '.qrShPb',
        '.rhsvw'
      ];
      
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          // Additional check to ensure it's actually a business profile
          const hasBusinessInfo = element.querySelector('[data-attrid="kc:/collection/knowledge_panels/has_rating:rating"]') ||
                                 element.querySelector('.Aq14fc') ||
                                 element.textContent?.includes('★') ||
                                 element.textContent?.includes('star') ||
                                 element.textContent?.includes('review');
          if (hasBusinessInfo) {
            return true;
          }
        }
      }
      return false;
    });
    
    if (!gbpCardExists) {
      // Debug: Take a screenshot or log page content for debugging
      const pageTitle = await page.title();
      console.log('Page title:', pageTitle);
      
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

    // Click on reviews to open them
    try {
      // Try to find and click "Google reviews" link using evaluate
      const reviewsLinkClicked = await page.evaluate(() => {
        // Look for spans containing "Google reviews" and find their parent links
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          if (span.textContent?.includes('Google reviews')) {
            const parentLink = span.closest('a');
            if (parentLink) {
              parentLink.click();
              return true;
            }
          }
        }
        return false;
      });

      if (reviewsLinkClicked) {
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
      } else {
        // Fallback: try clicking the rating stars directly
        const ratingClicked = await page.click('g-review-stars').catch(() => false);
        if (!ratingClicked) {
          await page.click('.Aq14fc');
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Wait for reviews to load
      await page.waitForSelector('.gws-localreviews__google-review', { timeout: 10000 });
    } catch (error) {
      console.log('Could not navigate to reviews:', error);
      // Continue without reviews
    }

    // Extract reviews using the correct selectors
    const reviews = await page.evaluate(() => {
      const reviewElements = document.querySelectorAll('.gws-localreviews__google-review');
      const extractedReviews: ReviewData[] = [];

      for (let i = 0; i < Math.min(reviewElements.length, 5); i++) {
        const reviewElement = reviewElements[i];
        
        try {
          // Extract reviewer name
          const nameElement = reviewElement.querySelector('.TSUbDb');
          const reviewerName = nameElement?.textContent?.trim() || 'Anonymous';
          
          // Extract rating from aria-label
          const ratingElement = reviewElement.querySelector('.EBe2gf');
          let rating = 0;
          if (ratingElement) {
            const ariaLabel = ratingElement.getAttribute('aria-label') || '';
            const ratingMatch = ariaLabel.match(/(\d+(\.\d+)?)\s*star/i);
            if (ratingMatch) {
              rating = parseFloat(ratingMatch[1]);
            }
          }
          
          // Extract review text
          const textElement = reviewElement.querySelector('.Jtu6Td');
          const reviewText = textElement?.textContent?.trim() || '';
          
          // Extract review date (if available)
          const dateElement = reviewElement.querySelector('.dehysf, .AuVD');
          const reviewDate = dateElement?.textContent?.trim() || '';

          if (reviewerName !== 'Anonymous' || reviewText) {
            extractedReviews.push({
              reviewerName,
              rating,
              reviewText,
              reviewDate
            });
          }
        } catch (err) {
          console.log('Error extracting review:', err);
          continue;
        }
      }
      
      return extractedReviews;
    });

    // Get business name from the page if possible
    let businessName = normalizedCompanyName;
    try {
      businessName = await page.evaluate(() => {
        const nameElement = document.querySelector('h2[data-attrid="title"], .qrShPb h2, .kp-header h2');
        return nameElement?.textContent?.trim() || '';
      }) || normalizedCompanyName;
    } catch (e) {
      // Use normalized name as fallback
    }

    await browser.close();

    if (reviews.length === 0 && overallRating === 0) {
      return res.status(200).json({
        success: false,
        companyName: businessName,
        message: 'Business found but no reviews data could be extracted.'
      });
    }

    return res.status(200).json({
      success: true,
      companyName: businessName,
      overallRating: overallRating,
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