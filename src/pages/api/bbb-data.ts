import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

// --- Main HTTP Request Handler ---
async function handler(req: Request): Promise<Response> {
  // Set CORS headers to allow requests from any origin
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight OPTIONS requests for CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Ensure the request method is POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // --- 1. Parse Incoming JSON Data ---
    const { companyName, city, state } = await req.json();

    if (!companyName || !city || !state) {
      return new Response(JSON.stringify({ message: "Missing required fields: companyName, city, state" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

    // --- 4. Parse HTML and Find the Company ---
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) {
      throw new Error("Failed to parse the HTML document.");
    }
    
    const resultCards = doc.querySelectorAll(".result-card");
    let foundCompanyData = null;

    for (const card of resultCards) {
      const nameElement = card.querySelector(".result-business-name a");
      
      // Clean the company name by removing HTML tags (like <em>) and extra whitespace
      const cardCompanyName = nameElement?.textContent.trim().replace(/\s+/g, ' ');

      // Case-insensitive comparison
      if (cardCompanyName?.toLowerCase() === companyName.toLowerCase()) {
        
        // --- 5. Extract Data from the Matched Card ---
        const ratingElement = card.querySelector(".result-rating");
        const accreditationImg = card.querySelector(".result-image-wrapper img");

        foundCompanyData = {
          company: cardCompanyName,
          bbbRating: ratingElement ? ratingElement.textContent.trim() : "Not found",
          accreditationStatus: accreditationImg ? accreditationImg.getAttribute("alt")?.trim() : "Not found",
        };
        break; // Stop searching once the exact match is found
      }
    }

    // --- 6. Construct and Send the Final JSON Response ---
    if (foundCompanyData) {
      return new Response(JSON.stringify(foundCompanyData), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      return new Response(JSON.stringify({ message: `No exact BBB record found for "${companyName}".` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

  } catch (error) {
    console.error("An error occurred:", error);
    return new Response(JSON.stringify({ message: "Internal Server Error", error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// --- Start the Deno Server ---
console.log("BBB Scraper API running on http://localhost:8000");
serve(handler, { port: 8000 });
