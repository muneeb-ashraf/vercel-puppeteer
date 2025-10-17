import type { NextApiRequest, NextApiResponse } from 'next';
import { JSDOM } from 'jsdom';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// --- A list of common browser User-Agent strings ---
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
];

// --- Main Next.js API Request Handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // --- CORS Headers ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ message: "Method Not Allowed" });
    return;
  }

  let browser = null;

  try {
    const { companyName, city, state } = req.body;

    if (!companyName || !city || !state) {
      res.status(400).json({ message: "Missing required fields: companyName, city, state" });
      return;
    }

    const findText = encodeURIComponent(companyName).replace(/%20/g, '+');
    const findLoc = encodeURIComponent(`${city}, ${state}`);
    const bbbUrl = `https://www.bbb.org/search?find_text=${findText}&find_loc=${findLoc}&find_country=USA`;

    // --- 1. Launch a headless browser instance ---
    // This configuration is optimized for serverless environments like Vercel
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    
    // --- 2. Set a random User-Agent to mimic a real browser ---
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    await page.setUserAgent(randomUserAgent);

    // --- 3. Navigate to the page and get HTML content ---
    await page.goto(bbbUrl, { waitUntil: 'domcontentloaded' });
    const html = await page.content();

    // --- 4. Parse HTML and find the company ---
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    const resultCards = doc.querySelectorAll(".result-card");
    let foundCompanyData = null;

    for (let i = 0; i < resultCards.length; i++) {
      const card = resultCards[i];
      const nameElement = card.querySelector(".result-business-name a");
      
      const cardCompanyName = nameElement?.textContent?.trim().replace(/\s+/g, ' ');

      if (cardCompanyName?.toLowerCase() === companyName.toLowerCase()) {
        
        const ratingElement = card.querySelector(".result-rating");
        const accreditationImg = card.querySelector(".result-image-wrapper img");

        foundCompanyData = {
          company: cardCompanyName,
          bbbRating: ratingElement?.textContent?.trim() || "Not found",
          accreditationStatus: accreditationImg ? (accreditationImg as HTMLImageElement).alt.trim() : "Not found",
        };
        break; 
      }
    }

    if (foundCompanyData) {
      res.status(200).json(foundCompanyData);
    } else {
      res.status(404).json({ message: `No exact BBB record found for "${companyName}".` });
    }

  } catch (error: any) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  } finally {
    // --- 5. Ensure the browser is closed ---
    if (browser !== null) {
      await browser.close();
    }
  }
}

