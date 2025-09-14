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

  try {
    const { html } = req.body as { html?: string };

    if (!html) {
      return res.status(400).json({ error: "Missing HTML content" });
    }

    // Enhanced Chromium args for better CSS/font support
    const args = [
      ...chromium.args,
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--font-render-hinting=none',
    ];

    const browser = await puppeteer.launch({
      args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Set viewport for consistent rendering
    await page.setViewport({ width: 1920, height: 1080 });

    // Enhanced content loading with better wait conditions
    await page.setContent(html, { 
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 30000 
    });

    // Wait for fonts to load (important for styling)
    await page.evaluateHandle('document.fonts.ready');

    // Additional wait for any dynamic content
    await page.waitForTimeout(1000);

    // Enhanced PDF generation options
    const pdfBuffer = await page.pdf({ 
      format: "A4",
      printBackground: true, // Critical: ensures CSS backgrounds and colors are printed
      margin: {
        top: '15mm',
        right: '15mm',
        bottom: '15mm',
        left: '15mm'
      },
      preferCSSPageSize: true, // Respects CSS @page rules
    });

    await browser.close();

    // Supabase client
    const supabase = createClient(
      process.env.VITE_SUPABASE_URL as string,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
    );

    // Unique filename
    const fileName = `report-${Date.now()}.pdf`;

    // Upload PDF
    const { error: uploadError } = await supabase.storage
      .from("pdf-reports")
      .upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
      });

    if (uploadError) {
      console.error(uploadError);
      return res.status(500).json({ error: "Failed to upload PDF" });
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from("pdf-reports")
      .getPublicUrl(fileName);

    if (!publicUrlData?.publicUrl) {
      return res.status(500).json({ error: "Could not retrieve public URL" });
    }

    return res.status(200).json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error("PDF generation error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}