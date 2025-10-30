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

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Wrap the HTML with styles that prevent page breaks
    const wrappedHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color-adjust: exact !important;
            }
            
            body {
              margin: 0;
              padding: 20px;
            }
            
            /* Prevent page breaks */
            * {
              page-break-inside: avoid !important;
              page-break-before: avoid !important;
              page-break-after: avoid !important;
              break-inside: avoid !important;
              break-before: avoid !important;
              break-after: avoid !important;
            }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `;

    await page.goto(`data:text/html;charset=UTF-8,${encodeURIComponent(wrappedHtml)}`, {
      waitUntil: "networkidle0",
    });

    await page.evaluateHandle('document.fonts.ready');

    // Get the full content height
    const contentHeight = await page.evaluate(() => {
      return document.documentElement.scrollHeight;
    });

    // Set viewport to match content - convert 317.5mm to pixels (317.5mm ≈ 1200px at 96dpi)
    const viewportWidth = Math.ceil(317.5 / 0.264583); // Convert mm to pixels
    await page.setViewport({
      width: viewportWidth,
      height: contentHeight,
      deviceScaleFactor: 2, // Higher quality
    });

    // Use PDF with calculated height and 317.5mm width
    const pdfBuffer = await page.pdf({
      width: '317.5mm',
      height: `${Math.ceil(contentHeight * 0.264583)}mm`, // Convert pixels to mm (1px ≈ 0.264583mm)
      printBackground: true,
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '0mm',
        left: '0mm',
      },
      displayHeaderFooter: false,
      preferCSSPageSize: false, // Don't use CSS page size
      pageRanges: '1', // Only first page
    });

    await browser.close();

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
      return res.status(500).json({ 
        error: "Failed to upload PDF", 
        details: uploadError.message 
      });
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
    return res.status(500).json({ 
      error: "Internal server error", 
      details: error 
    });
  }
}
