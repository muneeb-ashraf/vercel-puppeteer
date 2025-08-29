import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';

// Create Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { html } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'Missing HTML in request body.' });
    }

    // Launch Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required for Vercel
    });
    const page = await browser.newPage();

    // Load HTML directly
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Generate PDF
    const pdfBuffer = await page.pdf({ format: 'A4' });
    await browser.close();

    // Unique file name
    const fileName = `report-${uuidv4()}.pdf`;

    // Upload to Supabase bucket
    const { error: uploadError } = await supabase.storage
      .from('pdf-reports')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      return res.status(500).json({ error: 'Error uploading PDF to Supabase', details: uploadError });
    }

    // Generate public URL
    const { data } = supabase.storage.from('pdf-reports').getPublicUrl(fileName);

    return res.status(200).json({
      message: 'PDF generated successfully',
      pdf_url: data.publicUrl,
    });

  } catch (err) {
    console.error('PDF Generation Error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
