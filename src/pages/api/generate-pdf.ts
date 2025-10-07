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
      // FIX: 'ignoreHTTPSErrors' is not a valid launch option. It has been removed.
    });

    const page = await browser.newPage();

    // 1. Set content using a data URI with page.goto for more reliable loading
    await page.goto(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`, {
      waitUntil: "networkidle0",
    });

    // 2. CRITICAL FIX: Emulate the 'print' media type.
    await page.emulateMediaType("print");

    // 3. Generate PDF.
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "15mm",
        right: "15mm",
        bottom: "15mm",
        left: "15mm",
      },
      preferCSSPageSize: true,
    });

    await browser.close();

    // Supabase client - unchanged as requested
    const supabase = createClient(
      process.env.VITE_SUPABASE_URL as string,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string
    );

    // Unique filename
    const fileName = `report-${Date.now()}.pdf`;

    // Upload PDF
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

    // Get public URL
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
