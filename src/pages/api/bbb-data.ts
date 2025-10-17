import type { NextApiRequest, NextApiResponse } from 'next';
import { JSDOM } from 'jsdom';

// --- Main Next.js API Request Handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // --- CORS Headers ---
  // Set CORS headers to allow requests from any origin.
  // In a production app, you might want to restrict this to your frontend's domain.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS requests for CORS
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Ensure the request method is POST
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ message: "Method Not Allowed" });
    return;
  }

  try {
    // --- 1. Parse Incoming JSON Data ---
    // In Next.js, the body is already parsed on `req.body`
    const { companyName, city, state } = req.body;

    if (!companyName || !city || !state) {
      res.status(400).json({ message: "Missing required fields: companyName, city, state" });
      return;
    }

    // --- 2. Construct the BBB Search URL ---
    const findText = encodeURIComponent(companyName).replace(/%20/g, '+');
    const findLoc = encodeURIComponent(`${city}, ${state}`);
    const bbbUrl = `https://www.bbb.org/search?find_text=${findText}&find_loc=${findLoc}&find_country=USA`;

    // --- 3. Fetch the HTML from BBB Website ---
    const response = await fetch(bbbUrl, {
      headers: {
        // A User-Agent is often required to mimic a browser and avoid being blocked
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch from BBB: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    // --- 4. Parse HTML with jsdom and Find the Company ---
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    const resultCards = doc.querySelectorAll(".result-card");
    let foundCompanyData = null;

    for (const card of resultCards) {
      const nameElement = card.querySelector(".result-business-name a");
      
      // Clean the company name by removing HTML tags (like <em>) and extra whitespace
      const cardCompanyName = nameElement?.textContent?.trim().replace(/\s+/g, ' ');

      // Case-insensitive comparison
      if (cardCompanyName?.toLowerCase() === companyName.toLowerCase()) {
        
        // --- 5. Extract Data from the Matched Card ---
        const ratingElement = card.querySelector(".result-rating");
        const accreditationImg = card.querySelector(".result-image-wrapper img");

        foundCompanyData = {
          company: cardCompanyName,
          bbbRating: ratingElement ? ratingElement.textContent.trim() : "Not found",
          accreditationStatus: accreditationImg ? (accreditationImg as HTMLImageElement).alt.trim() : "Not found",
        };
        break; // Stop searching once the exact match is found
      }
    }

    // --- 6. Construct and Send the Final JSON Response ---
    if (foundCompanyData) {
      res.status(200).json(foundCompanyData);
    } else {
      res.status(404).json({ message: `No exact BBB record found for "${companyName}".` });
    }

  } catch (error: any) {
    console.error("An error occurred:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
}

