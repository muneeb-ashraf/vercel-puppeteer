import { NextApiRequest, NextApiResponse } from 'next';
import chromium from '@sparticuz/chromium';
import puppeteer, { Page } from 'puppeteer-core';
import { normalizeCompanyName } from "@/utils/normalizeCompanyName";

// -------------------
// Helper Functions
// -------------------
const normalize = (str: string) => str.toLowerCase().trim();

async function searchByCompanyName(page: Page, companyName: string) {
  const baseUrl = 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName';
  
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  
  // Enter company name in search input
  await page.type('#SearchTerm', companyName);
  
  // Click search button
  await page.click('input[type="submit"][value="Search Now"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Get all anchor tags with company names
  const links = await page.$$eval('a', (anchors: HTMLAnchorElement[]) =>
    anchors.map(a => ({ text: a.textContent?.trim() || '', href: a.href }))
  );

  const normalizedSearchName = normalizeCompanyName(companyName);

  // Look for exact matches (with or without comma)
  const exactMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    // Check if it's an exact match or exact match with comma variations
    return normalizedLinkText === normalizedSearchName ||
           normalizedLinkText === normalizedSearchName.replace(',', '') ||
           normalizedLinkText.replace(',', '') === normalizedSearchName;
  });

  // If exact match found, return the first one
  if (exactMatches.length > 0) {
    return exactMatches[0].href;
  }

  // Look for close matches (contains the search term)
  const closeMatches = links.filter(link => {
    const normalizedLinkText = normalizeCompanyName(link.text);
    return normalizedLinkText.includes(normalizedSearchName) ||
           normalizedSearchName.includes(normalizedLinkText);
  });

  // If close matches found, return them for review
  if (closeMatches.length > 0) {
    return { reviewNeeded: closeMatches.map(l => l.text) };
  }

  return null;
}

async function scrapeCompanyDetails(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle2" });

  // Scrape company details from the searchResultDetail div
  const companyData = await page.evaluate(() => {
    const detailDiv = document.querySelector('.searchResultDetail');
    if (!detailDiv) return {};

    const results: { [key: string]: any } = {};
    
    // Find and exclude Document Images section
    const documentImagesSection = Array.from(detailDiv.querySelectorAll('.detailSection'))
      .find(section => {
        const span = section.querySelector('span');
        return span && span.textContent?.trim() === 'Document Images';
      });

    // Extract company name and type
    const corporationNameDiv = detailDiv.querySelector('.corporationName');
    if (corporationNameDiv) {
      const paragraphs = corporationNameDiv.querySelectorAll('p');
      if (paragraphs.length >= 2) {
        results['Entity Type'] = paragraphs[0].textContent?.trim() || '';
        results['Entity Name'] = paragraphs[1].textContent?.trim() || '';
      }
    }

    // Extract all detail sections except Document Images
    const detailSections = Array.from(detailDiv.querySelectorAll('.detailSection'));
    
    detailSections.forEach(section => {
      // Skip Document Images section
      if (section === documentImagesSection) return;

      const firstSpan = section.querySelector('span');
      if (!firstSpan) return;

      const sectionTitle = firstSpan.textContent?.trim() || '';
      
      if (sectionTitle === 'Filing Information') {
        // Handle Filing Information section with label-value pairs
        const labels = section.querySelectorAll('label');
        labels.forEach(label => {
          const labelText = label.textContent?.trim() || '';
          const nextSpan = label.nextElementSibling;
          if (nextSpan && nextSpan.tagName.toLowerCase() === 'span') {
            const value = nextSpan.textContent?.trim() || '';
            if (labelText && value) {
              results[labelText] = value;
            }
          }
        });
      } else if (sectionTitle === 'Annual Reports') {
        // Handle Annual Reports table
        const table = section.querySelector('table');
        if (table) {
          const annualReports: { [key: string]: string } = {};
          const rows = Array.from(table.querySelectorAll('tr'));
          
          // Skip header row, process data rows
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 2) {
              const year = cells[0].textContent?.trim() || '';
              const filedDate = cells[1].textContent?.trim() || '';
              if (year && filedDate) {
                annualReports[year] = filedDate;
              }
            }
          }
          results['Annual Reports'] = annualReports;
        }
      } else if (sectionTitle === 'Authorized Person(s) Detail') {
        // Handle Authorized Persons section
        const authorizedPersons: any[] = [];
        const spans = Array.from(section.querySelectorAll('span'));
        
        let currentPerson: any = null;
        for (const span of spans) {
          const text = span.textContent?.trim() || '';
          
          if (text.startsWith('Title')) {
            if (currentPerson) {
              authorizedPersons.push(currentPerson);
            }
            currentPerson = { title: text.replace('Title', '').trim() };
          } else if (currentPerson && text && !text.includes('Name & Address') && !text.includes('<div>')) {
            // This might be a person's name
            const lines = text.split('\n').map(line => line.trim()).filter(line => line);
            if (lines.length > 0 && !currentPerson.name) {
              currentPerson.name = lines[0];
              if (lines.length > 1) {
                currentPerson.address = lines.slice(1).join(', ');
              }
            }
          }
        }
        if (currentPerson) {
          authorizedPersons.push(currentPerson);
        }
        
        if (authorizedPersons.length > 0) {
          results['Authorized Persons'] = authorizedPersons;
        }
      } else {
        // Handle other sections (Principal Address, Mailing Address, Registered Agent, etc.)
        const spans = Array.from(section.querySelectorAll('span'));
        
        if (spans.length >= 2) {
          let sectionData: any = {};
          
          // Get the main content (usually in the second span)
          for (let i = 1; i < spans.length; i++) {
            const span = spans[i];
            const text = span.textContent?.trim() || '';
            
            if (text && text !== sectionTitle) {
              // Check for address-like content
              const div = span.querySelector('div');
              if (div) {
                const addressText = div.innerHTML
                  .replace(/<br>/g, ', ')
                  .replace(/<[^>]*>/g, '')
                  .trim();
                
                if (!sectionData.address && addressText) {
                  sectionData.address = addressText;
                }
              } else if (!text.startsWith('Changed:')) {
                if (!sectionData.name && text) {
                  sectionData.name = text;
                }
              } else if (text.startsWith('Changed:')) {
                sectionData.changed = text.replace('Changed:', '').trim();
              }
            }
          }
          
          // Store the section data
          if (Object.keys(sectionData).length > 0) {
            if (sectionData.address && !sectionData.name) {
              results[sectionTitle] = sectionData.address;
            } else {
              results[sectionTitle] = sectionData;
            }
          }
        }
      }
    });

    return results;
  });

  return companyData;
}

// -------------------
// API Handler
// -------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { companyName } = req.body;
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });

    const page = await browser.newPage();
    
    const result = await searchByCompanyName(page, companyName);

    if (!result) {
      await browser.close();
      return res.status(404).json({ error: 'Company not found.' });
    }

    if ((result as any).reviewNeeded) {
      await browser.close();
      return res.status(200).json({ review: (result as any).reviewNeeded.join(', ') });
    }

    const responseData = await scrapeCompanyDetails(page, result as string);
    
    await browser.close();
    return res.status(200).json({ data: responseData });

  } catch (err) {
    if (browser) await browser.close();
    const error = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error });
  }
}