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

    // Wrap the HTML with styles for A4 printing
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
            
            @page {
              size: A4;
              margin: 0;
            }
            
            body {
              margin: 0;
              padding: 20px;
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

    // Set viewport to A4 dimensions (210mm x 297mm at 96dpi)
    await page.setViewport({
      width: 794,  // 210mm in pixels at 96dpi
      height: 1123, // 297mm in pixels at 96dpi
      deviceScaleFactor: 2,
    });

    // Generate A4 PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '0mm',
        left: '0mm',
      },
      displayHeaderFooter: false,
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

