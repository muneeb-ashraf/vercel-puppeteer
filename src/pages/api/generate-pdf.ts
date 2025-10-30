import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed, use POST" });
  }

  try {
    const { html } = req.body as { html?: string };

    if (!html) {
      return res.status(400).json({ error: "Missing HTML content" });
    }
    
    // NEW: Remove the @page CSS rule. 
    // This rule conflicts with rendering a single, full-height page.
    const modifiedHtml = html.replace(/@page\s*{[^}]*}/g, '');

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Use the modified HTML that has no @page rule
    await page.goto(`data:text/html;charset=UTF-8,${encodeURIComponent(modifiedHtml)}`, {
      waitUntil: "networkidle0",
    });

    // Ensure all fonts are loaded
    await page.evaluateHandle('document.fonts.ready');

    // REMOVED: await page.emulateMediaType("print");
    // This was the main cause of the pagination problem.

    // REVISED: These options create a single PDF as long as the content.
    const pdfBuffer = await page.pdf({
      // This is the fixed width you defined in your CSS.
      width: '317.5mm', 
      // By OMITTING 'height', Puppeteer renders the full page height.
      printBackground: true,
      // All other print-specific options (margin, displayHeaderFooter, preferCSSPageSize)
      // are removed as they are no longer relevant.
    });

    await browser.close();

    // Supabase client - unchanged
    const supabase = createClient(
      process.env.VITE_SUPABASE_URL as string,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
    );

    const fileName = `report-${Date.now()}.pdf`;

    const { data, error: uploadError } = await supabase.storage
      .from("pdf-reports")
      .upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase Upload Error:", uploadError.message);
      return res.status(500).json({ error: "Failed to upload PDF", details: uploadError.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from("pdf-reports")
      .getPublicUrl(fileName);

    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({ error: "Could not retrieve public URL" });
    }

    return res.status(200).json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error("PDF Generation Error:", err);
    const error = err instanceof Error ? err.message : "An unknown error occurred.";
    return res.status(500).json({ error: "Internal server error", details: error });
  }
}
