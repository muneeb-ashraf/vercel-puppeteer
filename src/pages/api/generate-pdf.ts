import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed, use POST" });
  }

  let browser = null;
  try {
    const { html } = req.body as { html?: string };

    if (!html) {
      return res.status(400).json({ error: "Missing HTML content" });
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: "shell", // Use modern headless mode
    });

    const page = await browser.newPage();

    // --- KEY FIXES FOR PDF LAYOUT ---

    // 1. Emulate a print media type. This is the most crucial step.
    // It makes the browser render the page as if it's being printed,
    // which aligns the layout engine with the final PDF output.
    await page.emulateMediaType('print');

    // 2. Set the content. The viewport emulation is removed because it's for screen media
    // and can cause conflicts with print media rendering, leading to extra pages.
    await page.setContent(html, {
      waitUntil: "networkidle0", // Wait for all network activity to cease (images, fonts, etc.)
      timeout: 30000,
    });

    // It's good practice to wait for fonts to be fully loaded before generating the PDF
    await page.evaluateHandle('document.fonts.ready');
    
    // --- END OF KEY FIXES ---

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true, // Essential for rendering CSS background colors and images
      margin: {
        top: '15mm',
        right: '15mm',
        bottom: '15mm',
        left: '15mm',
      },
      // This respects any @page rules you have in your CSS, which is great for print.
      preferCSSPageSize: true, 
    });

    await browser.close();
    browser = null; // Ensure browser is marked as closed

    // --- SECURITY & BEST PRACTICE IMPROVEMENT ---
    // Use secure, server-side environment variables for backend operations.
    // VITE_ or NEXT_PUBLIC_ variables are exposed to the client-side.
    const supabase = createClient(
      process.env.VITE_SUPABASE_URL as string,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
    );

    const fileName = `report-${Date.now()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("pdf-reports")
      .upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
        upsert: false, // Prevent overwriting files
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload PDF", details: uploadError.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from("pdf-reports")
      .getPublicUrl(fileName);

    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({ error: "Could not retrieve public URL for the PDF" });
    }

    return res.status(200).json({ url: publicUrlData.publicUrl });
  } catch (err) {
    if (browser) {
      await browser.close();
    }
    console.error("PDF generation error:", err);
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred.";
    return res.status(500).json({ error: "Internal server error", details: errorMessage });
  }
}
