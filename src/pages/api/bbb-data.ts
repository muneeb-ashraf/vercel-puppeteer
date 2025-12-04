import type { NextApiRequest, NextApiResponse } from 'next';
import { JSDOM } from 'jsdom';
import chromium from '@sparticuz/chromium';
import puppeteer, { Browser, Page } from 'puppeteer-core';

// ============================================
// CONFIGURATION
// ============================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

// Minimum match score to consider a result valid (0-1)
const MIN_MATCH_SCORE = 0.65;

// Maximum number of search attempts with different variations
const MAX_SEARCH_ATTEMPTS = 3;

/**
 * Delay utility function (replacement for deprecated waitForTimeout)
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// TYPE DEFINITIONS
// ============================================

interface BBBCompanyData {
  company: string;
  bbbRating: string;
  accreditationStatus: string;
  profileUrl?: string;
  phoneNumber?: string;
  address?: string;
  yearsInBusiness?: string;
  matchScore?: number;
  matchType?: string;
  searchQuery?: string;
}

interface BBBSearchResult {
  success: boolean;
  data?: BBBCompanyData;
  message: string;
  searchAttempts?: string[];
  allCandidates?: Array<{
    name: string;
    score: number;
    matchType: string;
  }>;
}

interface ParsedResultCard {
  companyName: string;
  bbbRating: string;
  accreditationStatus: string;
  profileUrl?: string;
  phoneNumber?: string;
  address?: string;
  yearsInBusiness?: string;
}

// ============================================
// BUSINESS NAME UTILITIES
// ============================================

/**
 * Common business suffixes to handle variations
 */
const BUSINESS_SUFFIXES = [
  // Full forms
  'limited liability company',
  'limited liability corp',
  'incorporated',
  'corporation',
  'company',
  'limited',
  'enterprise',
  'enterprises',
  'services',
  'service',
  'group',
  'holdings',
  'solutions',
  'partners',
  'associates',
  // Abbreviations (order matters - longer first)
  'l.l.c.',
  'l.l.c',
  'llc',
  'inc.',
  'inc',
  'corp.',
  'corp',
  'co.',
  'co',
  'ltd.',
  'ltd',
  'l.l.p.',
  'llp',
  'p.l.l.c.',
  'pllc',
  'p.c.',
  'pc',
  'p.a.',
  'pa',
  'd.b.a.',
  'd/b/a',
  'dba',
];

/**
 * Words that can be ignored for matching purposes
 */
const IGNORABLE_WORDS = ['the', 'and', '&', 'of', 'at', 'in', 'on', 'for', 'a', 'an'];

/**
 * Normalize a company name for comparison
 */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,\-_'"!@#$%^&*()+=\[\]{}|\\:;<>?\/~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove business suffixes from a company name
 */
function removeBusinessSuffixes(name: string): string {
  let normalized = normalizeCompanyName(name);
  
  // Sort suffixes by length (longest first) to avoid partial replacements
  const sortedSuffixes = [...BUSINESS_SUFFIXES].sort((a, b) => b.length - a.length);
  
  for (const suffix of sortedSuffixes) {
    const escapedSuffix = suffix.replace(/\./g, '\\.').replace(/\//g, '\\/');
    const regex = new RegExp(`\\b${escapedSuffix}\\s*$`, 'i');
    normalized = normalized.replace(regex, '').trim();
  }
  
  return normalized.trim();
}

/**
 * Remove ignorable words from a name
 */
function removeIgnorableWords(name: string): string {
  const words = name.split(' ');
  return words
    .filter(word => !IGNORABLE_WORDS.includes(word.toLowerCase()))
    .join(' ');
}

/**
 * Extract core business name (without suffixes and ignorable words)
 */
function extractCoreName(name: string): string {
  let coreName = normalizeCompanyName(name);
  coreName = removeBusinessSuffixes(coreName);
  coreName = removeIgnorableWords(coreName);
  return coreName.trim();
}

/**
 * Generate multiple variations of a company name for searching
 */
function generateNameVariations(companyName: string): string[] {
  const variations = new Set<string>();
  const normalized = normalizeCompanyName(companyName);
  const coreName = extractCoreName(companyName);
  
  // 1. Original name (cleaned up)
  variations.add(companyName.trim());
  
  // 2. Core name without suffixes
  variations.add(coreName);
  
  // 3. Core name with common suffixes (BBB often shows these)
  const commonSuffixes = ['LLC', 'Inc', 'Corp', 'Co', 'Inc.', 'LLC.'];
  for (const suffix of commonSuffixes) {
    variations.add(`${coreName} ${suffix}`);
    variations.add(`${coreName}, ${suffix}`); // BBB often uses comma before suffix
  }
  
  // 4. Handle "and" / "&" variations
  if (coreName.includes(' and ')) {
    variations.add(coreName.replace(/ and /g, ' & '));
  }
  if (coreName.includes(' & ')) {
    variations.add(coreName.replace(/ & /g, ' and '));
  }
  
  // 5. Handle common abbreviations
  const abbreviationMap: { [key: string]: string[] } = {
    'saint': ['st', 'st.'],
    'st': ['saint'],
    'mount': ['mt', 'mt.'],
    'mt': ['mount'],
    'doctor': ['dr', 'dr.'],
    'dr': ['doctor'],
    'mister': ['mr', 'mr.'],
    'mr': ['mister'],
  };
  
  for (const [full, abbrevs] of Object.entries(abbreviationMap)) {
    if (coreName.includes(full)) {
      for (const abbrev of abbrevs) {
        variations.add(coreName.replace(new RegExp(`\\b${full}\\b`, 'gi'), abbrev));
      }
    }
  }
  
  // 6. First few words (for very long names)
  const words = coreName.split(' ').filter(w => w.length > 1);
  if (words.length > 3) {
    variations.add(words.slice(0, 2).join(' '));
    variations.add(words.slice(0, 3).join(' '));
  }
  
  // Convert to array and filter empty/duplicate strings
  return Array.from(variations)
    .filter(v => v.length > 0)
    .map(v => v.trim());
}

/**
 * Generate search query variations for BBB
 */
function generateSearchQueries(companyName: string): string[] {
  const queries = new Set<string>();
  const coreName = extractCoreName(companyName);
  
  // Original name
  queries.add(companyName.trim());
  
  // Core name only (most flexible search)
  queries.add(coreName);
  
  // Without special characters
  queries.add(companyName.replace(/[&]/g, 'and').trim());
  
  return Array.from(queries).filter(q => q.length > 0);
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  
  return dp[m][n];
}

/**
 * Calculate similarity score between two strings (0 to 1)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  if (s1 === s2) return 1;
  
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1;
  
  const distance = levenshteinDistance(s1, s2);
  return 1 - (distance / maxLength);
}

/**
 * Check if one string contains all significant words from another
 */
function containsAllWords(haystack: string, needle: string): boolean {
  const haystackWords = new Set(haystack.toLowerCase().split(' ').filter(w => w.length > 1));
  const needleWords = needle.toLowerCase().split(' ').filter(w => w.length > 2 && !IGNORABLE_WORDS.includes(w));
  
  if (needleWords.length === 0) return false;
  
  const matchCount = needleWords.filter(word => 
    haystackWords.has(word) || 
    Array.from(haystackWords).some(hw => hw.includes(word) || word.includes(hw))
  ).length;
  
  return (matchCount / needleWords.length) >= 0.8;
}

/**
 * Calculate comprehensive match score between search name and result name
 */
function calculateMatchScore(searchName: string, resultName: string): { score: number; matchType: string } {
  const searchCore = extractCoreName(searchName);
  const resultCore = extractCoreName(resultName);
  const searchNormalized = normalizeCompanyName(searchName);
  const resultNormalized = normalizeCompanyName(resultName);
  
  // 1. Exact match on normalized names
  if (searchNormalized === resultNormalized) {
    return { score: 1.0, matchType: 'exact' };
  }
  
  // 2. Exact match on core names (ignoring suffixes)
  if (searchCore === resultCore) {
    return { score: 0.98, matchType: 'core_exact' };
  }
  
  // 3. One core name contains the other
  if (resultCore.includes(searchCore)) {
    const ratio = searchCore.length / resultCore.length;
    return { score: 0.90 + (ratio * 0.08), matchType: 'search_in_result' };
  }
  
  if (searchCore.includes(resultCore)) {
    const ratio = resultCore.length / searchCore.length;
    return { score: 0.85 + (ratio * 0.10), matchType: 'result_in_search' };
  }
  
  // 4. All significant words match
  if (containsAllWords(resultCore, searchCore)) {
    return { score: 0.85, matchType: 'word_match' };
  }
  
  if (containsAllWords(searchCore, resultCore)) {
    return { score: 0.82, matchType: 'reverse_word_match' };
  }
  
  // 5. High fuzzy similarity on core names
  const coreSimilarity = calculateSimilarity(searchCore, resultCore);
  if (coreSimilarity >= 0.85) {
    return { score: coreSimilarity * 0.95, matchType: 'fuzzy_high' };
  }
  
  // 6. Medium fuzzy similarity
  if (coreSimilarity >= 0.70) {
    return { score: coreSimilarity * 0.90, matchType: 'fuzzy_medium' };
  }
  
  // 7. Word overlap analysis
  const searchWords = searchCore.split(' ').filter(w => w.length > 2);
  const resultWords = resultCore.split(' ').filter(w => w.length > 2);
  
  if (searchWords.length > 0 && resultWords.length > 0) {
    const commonWords = searchWords.filter(sw => 
      resultWords.some(rw => sw === rw || sw.includes(rw) || rw.includes(sw))
    );
    const overlapRatio = commonWords.length / Math.max(searchWords.length, resultWords.length);
    
    if (overlapRatio >= 0.5) {
      return { score: 0.60 + (overlapRatio * 0.25), matchType: 'partial_overlap' };
    }
  }
  
  // 8. Fallback - return the similarity score
  return { score: coreSimilarity * 0.5, matchType: 'low_similarity' };
}

/**
 * Find the best matching company from parsed results
 */
function findBestMatch(
  searchName: string,
  results: ParsedResultCard[],
  minScore: number = MIN_MATCH_SCORE
): { match: ParsedResultCard | null; score: number; matchType: string; allScores: Array<{ name: string; score: number; matchType: string }> } {
  
  const nameVariations = generateNameVariations(searchName);
  let bestMatch: ParsedResultCard | null = null;
  let bestScore = 0;
  let bestMatchType = '';
  const allScores: Array<{ name: string; score: number; matchType: string }> = [];
  
  console.log(`[BBB_DEBUG] Evaluating ${results.length} results against ${nameVariations.length} name variations`);
  
  for (const result of results) {
    let resultBestScore = 0;
    let resultBestMatchType = '';
    
    // Test against all name variations
    for (const variation of nameVariations) {
      const { score, matchType } = calculateMatchScore(variation, result.companyName);
      
      if (score > resultBestScore) {
        resultBestScore = score;
        resultBestMatchType = matchType;
      }
    }
    
    allScores.push({
      name: result.companyName,
      score: resultBestScore,
      matchType: resultBestMatchType
    });
    
    console.log(`[BBB_DEBUG] "${result.companyName}" | Score: ${resultBestScore.toFixed(3)} | Type: ${resultBestMatchType}`);
    
    if (resultBestScore >= minScore && resultBestScore > bestScore) {
      bestMatch = result;
      bestScore = resultBestScore;
      bestMatchType = resultBestMatchType;
    }
  }
  
  // Sort all scores for logging
  allScores.sort((a, b) => b.score - a.score);
  
  return { match: bestMatch, score: bestScore, matchType: bestMatchType, allScores };
}

// ============================================
// HTML PARSING
// ============================================

/**
 * Parse BBB search results from HTML
 */
function parseSearchResults(html: string): ParsedResultCard[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: ParsedResultCard[] = [];
  
  // Try multiple selectors as BBB might change their HTML structure
  const selectors = [
    '.result-card',
    '[data-testid="result-card"]',
    '.search-result-item',
    '.bds-listing'
  ];
  
  let resultCards: NodeListOf<Element> | null = null;
  
  for (const selector of selectors) {
    resultCards = doc.querySelectorAll(selector);
    if (resultCards && resultCards.length > 0) {
      console.log(`[BBB_DEBUG] Found ${resultCards.length} results using selector: ${selector}`);
      break;
    }
  }
  
  if (!resultCards || resultCards.length === 0) {
    console.log('[BBB_DEBUG] No result cards found with any selector');
    return results;
  }
  
  // Convert NodeListOf to Array for iteration compatibility
  const cards = Array.from(resultCards);
  
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    try {
      // Company name - try multiple selectors
      const nameSelectors = [
        '.result-business-name a',
        '.bds-listing-title a',
        'h3 a',
        '.business-name a',
        'a.result-name'
      ];
      
      let companyName = '';
      let profileUrl = '';
      
      for (const nameSelector of nameSelectors) {
        const nameElement = card.querySelector(nameSelector);
        if (nameElement?.textContent) {
          companyName = nameElement.textContent.trim().replace(/\s+/g, ' ');
          profileUrl = (nameElement as HTMLAnchorElement).href || '';
          break;
        }
      }
      
      if (!companyName) continue;
      
      // BBB Rating
      const ratingSelectors = ['.result-rating', '.bds-rating', '[class*="rating"]'];
      let bbbRating = 'Not found';
      
      for (const ratingSelector of ratingSelectors) {
        const ratingElement = card.querySelector(ratingSelector);
        if (ratingElement?.textContent) {
          bbbRating = ratingElement.textContent.trim();
          break;
        }
      }
      
      // Accreditation Status
      const accreditationSelectors = [
        '.result-image-wrapper img',
        '.accreditation-image img',
        'img[alt*="accredit"]',
        'img[alt*="BBB"]'
      ];
      let accreditationStatus = 'Not found';
      
      for (const accredSelector of accreditationSelectors) {
        const accredImg = card.querySelector(accredSelector) as HTMLImageElement;
        if (accredImg?.alt) {
          accreditationStatus = accredImg.alt.trim();
          break;
        }
      }
      
      // Phone number (if available)
      const phoneElement = card.querySelector('.result-phone, .bds-phone, [class*="phone"]');
      const phoneNumber = phoneElement?.textContent?.trim();
      
      // Address (if available)
      const addressElement = card.querySelector('.result-address, .bds-address, [class*="address"]');
      const address = addressElement?.textContent?.trim().replace(/\s+/g, ' ');
      
      // Years in business (if available)
      const yearsElement = card.querySelector('[class*="years"], [class*="business-age"]');
      const yearsInBusiness = yearsElement?.textContent?.trim();
      
      results.push({
        companyName,
        bbbRating,
        accreditationStatus,
        profileUrl,
        phoneNumber,
        address,
        yearsInBusiness
      });
      
    } catch (err) {
      console.error('[BBB_DEBUG] Error parsing result card:', err);
    }
  }
  
  return results;
}

// ============================================
// BROWSER UTILITIES
// ============================================

/**
 * Launch browser with optimized settings
 */
async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

/**
 * Configure page with anti-detection measures
 */
async function configurePage(page: Page): Promise<void> {
  // Random user agent
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  await page.setUserAgent(userAgent);
  
  // Set viewport
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Set extra headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  
  // Mask webdriver detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

/**
 * Search BBB with a specific query
 */
async function searchBBB(
  page: Page,
  searchQuery: string,
  city: string,
  state: string
): Promise<ParsedResultCard[]> {
  const findText = encodeURIComponent(searchQuery).replace(/%20/g, '+');
  const findLoc = encodeURIComponent(`${city}, ${state}`);
  const bbbUrl = `https://www.bbb.org/search?find_text=${findText}&find_loc=${findLoc}&find_country=USA`;
  
  console.log(`[BBB_DEBUG] Searching: ${bbbUrl}`);
  
  try {
    await page.goto(bbbUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Wait a bit for dynamic content
    await delay(2000);
    
    // Try to wait for results to load
    try {
      await page.waitForSelector('.result-card, .bds-listing, .search-result-item', { timeout: 5000 });
    } catch {
      console.log('[BBB_DEBUG] Results selector not found, continuing with current content');
    }
    
    const html = await page.content();
    return parseSearchResults(html);
    
  } catch (err) {
    console.error(`[BBB_DEBUG] Error searching BBB:`, err);
    return [];
  }
}

// ============================================
// MAIN API HANDLER
// ============================================

export default async function handler(req: NextApiRequest, res: NextApiResponse<BBBSearchResult>) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ 
      success: false, 
      message: "Method Not Allowed" 
    });
  }

  let browser: Browser | null = null;

  try {
    const { companyName, city, state } = req.body;

    if (!companyName || !city || !state) {
      return res.status(400).json({ 
        success: false,
        message: "Missing required fields: companyName, city, state" 
      });
    }

    console.log(`[BBB_DEBUG] ========================================`);
    console.log(`[BBB_DEBUG] Searching BBB for: "${companyName}" in ${city}, ${state}`);

    // Generate search queries
    const searchQueries = generateSearchQueries(companyName);
    console.log(`[BBB_DEBUG] Generated ${searchQueries.length} search queries:`, searchQueries);

    // Launch browser
    browser = await launchBrowser();
    const page = await browser.newPage();
    await configurePage(page);

    let allResults: ParsedResultCard[] = [];
    const searchAttempts: string[] = [];

    // Try multiple search queries
    for (let i = 0; i < Math.min(searchQueries.length, MAX_SEARCH_ATTEMPTS); i++) {
      const query = searchQueries[i];
      searchAttempts.push(query);
      
      console.log(`[BBB_DEBUG] Attempt ${i + 1}: Searching for "${query}"`);
      
      const results = await searchBBB(page, query, city, state);
      
      // Add unique results
      for (const result of results) {
        const exists = allResults.some(r => 
          normalizeCompanyName(r.companyName) === normalizeCompanyName(result.companyName)
        );
        if (!exists) {
          allResults.push(result);
        }
      }
      
      console.log(`[BBB_DEBUG] Found ${results.length} results (Total unique: ${allResults.length})`);
      
      // If we have enough results, stop searching
      if (allResults.length >= 10) break;
    }

    if (allResults.length === 0) {
      console.log(`[BBB_DEBUG] No results found after all search attempts`);
      return res.status(404).json({
        success: false,
        message: `No BBB record found for "${companyName}" in ${city}, ${state}.`,
        searchAttempts
      });
    }

    // Find the best match using fuzzy matching
    const { match, score, matchType, allScores } = findBestMatch(companyName, allResults);

    if (!match) {
      console.log(`[BBB_DEBUG] No match found above threshold (${MIN_MATCH_SCORE})`);
      return res.status(404).json({
        success: false,
        message: `No matching BBB record found for "${companyName}". Closest matches below confidence threshold.`,
        searchAttempts,
        allCandidates: allScores.slice(0, 5) // Return top 5 candidates
      });
    }

    console.log(`[BBB_DEBUG] SUCCESS: Best match "${match.companyName}" (Score: ${score.toFixed(3)}, Type: ${matchType})`);

    return res.status(200).json({
      success: true,
      message: `Found BBB record for "${match.companyName}"`,
      data: {
        company: match.companyName,
        bbbRating: match.bbbRating,
        accreditationStatus: match.accreditationStatus,
        profileUrl: match.profileUrl,
        phoneNumber: match.phoneNumber,
        address: match.address,
        yearsInBusiness: match.yearsInBusiness,
        matchScore: Math.round(score * 100) / 100,
        matchType: matchType,
        searchQuery: searchAttempts[0]
      },
      searchAttempts
    });

  } catch (error: any) {
    console.error("[BBB_DEBUG] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Export utilities for testing
export { 
  generateNameVariations, 
  calculateMatchScore, 
  extractCoreName, 
  normalizeCompanyName,
  findBestMatch 
};
