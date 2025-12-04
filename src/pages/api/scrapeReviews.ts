import { createClient } from '@supabase/supabase-js';
import { NextApiRequest, NextApiResponse } from 'next';

// Initialize Supabase client
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing required Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ============================================
// TYPE DEFINITIONS
// ============================================

interface GooglePlaceSearchResult {
  place_id: string;
  name: string;
  rating?: number;
  user_ratings_total?: number;
  vicinity?: string;
  formatted_address?: string;
  types?: string[];
}

interface GooglePlaceSearchResponse {
  status: string;
  results: GooglePlaceSearchResult[];
  error_message?: string;
}

interface GoogleReview {
  author_name: string;
  rating: number;
  text: string;
  time: number;
  relative_time_description: string;
  profile_photo_url?: string;
}

interface GooglePlaceDetails {
  name: string;
  rating?: number;
  user_ratings_total?: number;
  reviews?: GoogleReview[];
  formatted_address?: string;
  formatted_phone_number?: string;
  website?: string;
  address_components?: {
    long_name: string;
    short_name: string;
    types: string[];
  }[];
}

interface GooglePlaceDetailsResponse {
  status: string;
  result: GooglePlaceDetails;
  error_message?: string;
}

interface ProcessedReview {
  author_name: string;
  rating: number;
  text: string;
  time: number;
  relative_time_description: string;
  profile_photo_url?: string;
}

interface ReviewsData {
  success: boolean;
  message: string;
  rating: number | null;
  total_ratings?: number;
  reviews: {
    positive: ProcessedReview[];
    negative: ProcessedReview[];
    all: ProcessedReview[];
  } | ProcessedReview[];
  business_found: boolean;
  business_name?: string;
  business_address?: string;
  business_phone?: string;
  business_website?: string;
  search_query?: string;
  place_id?: string;
  match_type?: string;
  match_score?: number;
  error?: string;
}

interface ApiRequest extends NextApiRequest {
  body: {
    companyName: string;
    state?: string;
  };
}

interface MatchResult {
  business: GooglePlaceSearchResult;
  score: number;
  matchType: string;
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
  // Abbreviations
  'llc',
  'l.l.c.',
  'l.l.c',
  'inc',
  'inc.',
  'corp',
  'corp.',
  'co',
  'co.',
  'ltd',
  'ltd.',
  'llp',
  'l.l.p.',
  'pllc',
  'p.l.l.c.',
  'pc',
  'p.c.',
  'pa',
  'p.a.',
  'dba',
  'd.b.a.',
  'd/b/a',
];

/**
 * Common words that can be ignored for matching
 */
const IGNORABLE_WORDS = [
  'the',
  'and',
  '&',
  'of',
  'at',
  'in',
  'on',
  'for',
];

/**
 * Industry-specific keywords that might appear in business names
 */
const INDUSTRY_KEYWORDS = [
  'roofing',
  'plumbing',
  'electrical',
  'hvac',
  'construction',
  'contracting',
  'contractors',
  'contractor',
  'builders',
  'building',
  'remodeling',
  'renovation',
  'renovations',
  'restoration',
  'repair',
  'repairs',
  'maintenance',
  'landscaping',
  'painting',
  'flooring',
  'cleaning',
  'moving',
  'storage',
  'pest control',
  'air conditioning',
  'heating',
  'cooling',
];

/**
 * Normalize a company name for comparison
 * Removes punctuation, extra spaces, and converts to lowercase
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
    // Match suffix at the end of the string with word boundary
    const regex = new RegExp(`\\b${suffix.replace(/\./g, '\\.')}\\s*$`, 'i');
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
  
  // 1. Original name
  variations.add(companyName);
  variations.add(normalized);
  
  // 2. Core name without suffixes
  variations.add(coreName);
  
  // 3. Core name with common suffixes
  const commonSuffixes = ['LLC', 'Inc', 'Corp', 'Co', ''];
  for (const suffix of commonSuffixes) {
    if (suffix) {
      variations.add(`${coreName} ${suffix}`);
    }
  }
  
  // 4. Handle "and" / "&" variations
  if (coreName.includes(' and ')) {
    variations.add(coreName.replace(/ and /g, ' & '));
  }
  if (coreName.includes(' & ')) {
    variations.add(coreName.replace(/ & /g, ' and '));
  }
  
  // 5. Handle hyphenated names
  if (coreName.includes('-')) {
    variations.add(coreName.replace(/-/g, ' '));
  }
  
  // 6. Handle multi-word names (try first two words if name is long)
  const words = coreName.split(' ').filter(w => w.length > 1);
  if (words.length > 2) {
    variations.add(words.slice(0, 2).join(' '));
    variations.add(words.slice(0, 3).join(' '));
  }
  
  // Convert to array and filter empty strings
  return Array.from(variations).filter(v => v.length > 0);
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  
  // Create a 2D array to store distances
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  // Initialize first column
  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  
  // Initialize first row
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  
  // Fill in the rest of the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
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
  const needleWords = needle.toLowerCase().split(' ').filter(w => w.length > 2);
  
  // At least 80% of words should match
  const matchCount = needleWords.filter(word => haystackWords.has(word)).length;
  return needleWords.length > 0 && (matchCount / needleWords.length) >= 0.8;
}

/**
 * Calculate a comprehensive match score between search name and result name
 */
function calculateMatchScore(searchName: string, resultName: string): { score: number; matchType: string } {
  const searchCore = extractCoreName(searchName);
  const resultCore = extractCoreName(resultName);
  const searchNormalized = normalizeCompanyName(searchName);
  const resultNormalized = normalizeCompanyName(resultName);
  
  // 1. Exact match (highest priority)
  if (searchNormalized === resultNormalized) {
    return { score: 1.0, matchType: 'exact' };
  }
  
  // 2. Core name exact match
  if (searchCore === resultCore) {
    return { score: 0.95, matchType: 'core_exact' };
  }
  
  // 3. One contains the other completely
  if (resultCore.includes(searchCore) || searchCore.includes(resultCore)) {
    const containmentRatio = Math.min(searchCore.length, resultCore.length) / 
                             Math.max(searchCore.length, resultCore.length);
    return { score: 0.85 + (containmentRatio * 0.1), matchType: 'containment' };
  }
  
  // 4. Word-based matching
  if (containsAllWords(resultCore, searchCore)) {
    return { score: 0.80, matchType: 'word_match' };
  }
  
  // 5. Fuzzy similarity on core names
  const coreSimilarity = calculateSimilarity(searchCore, resultCore);
  if (coreSimilarity >= 0.85) {
    return { score: coreSimilarity * 0.9, matchType: 'fuzzy_high' };
  }
  
  // 6. Fuzzy similarity on full normalized names
  const fullSimilarity = calculateSimilarity(searchNormalized, resultNormalized);
  if (fullSimilarity >= 0.75) {
    return { score: fullSimilarity * 0.85, matchType: 'fuzzy_medium' };
  }
  
  // 7. Partial word overlap
  const searchWords = searchCore.split(' ').filter(w => w.length > 2);
  const resultWords = resultCore.split(' ').filter(w => w.length > 2);
  const commonWords = searchWords.filter(w => resultWords.some(rw => rw.includes(w) || w.includes(rw)));
  
  if (commonWords.length > 0 && searchWords.length > 0) {
    const overlapRatio = commonWords.length / searchWords.length;
    if (overlapRatio >= 0.5) {
      return { score: 0.6 + (overlapRatio * 0.2), matchType: 'partial_overlap' };
    }
  }
  
  // 8. Low similarity fallback
  return { score: Math.max(coreSimilarity, fullSimilarity) * 0.5, matchType: 'low_similarity' };
}

/**
 * Find the best matching business from search results
 */
function findBestMatch(
  searchName: string, 
  results: GooglePlaceSearchResult[], 
  minScore: number = 0.6
): MatchResult | null {
  const searchVariations = generateNameVariations(searchName);
  let bestMatch: MatchResult | null = null;
  
  console.log(`[GOOGLE_REVIEWS_DEBUG] Searching with variations:`, searchVariations.slice(0, 5));
  
  for (const result of results) {
    // Calculate score against all variations and take the best
    let bestVariationScore = 0;
    let bestMatchType = '';
    
    for (const variation of searchVariations) {
      const { score, matchType } = calculateMatchScore(variation, result.name);
      if (score > bestVariationScore) {
        bestVariationScore = score;
        bestMatchType = matchType;
      }
    }
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Result: "${result.name}" | Score: ${bestVariationScore.toFixed(3)} | Type: ${bestMatchType}`);
    
    // Update best match if this is better
    if (bestVariationScore >= minScore && (!bestMatch || bestVariationScore > bestMatch.score)) {
      bestMatch = {
        business: result,
        score: bestVariationScore,
        matchType: bestMatchType
      };
    }
  }
  
  return bestMatch;
}

// ============================================
// MAIN API FUNCTION
// ============================================

/**
 * Fetch Google Reviews for a business using Google Places API
 * @param companyName - The name of the company to search for
 * @param state - The state to search in (default: Florida)
 * @returns Reviews data with rating and reviews
 */
async function fetchGoogleReviews(companyName: string, state: string = 'Florida'): Promise<ReviewsData> {
  try {
    console.log(`[GOOGLE_REVIEWS_DEBUG] ========================================`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Starting Google Reviews fetch for: "${companyName}" in ${state}`);
    
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!googleApiKey) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API key not configured`);
      throw new Error('Google Places API key not configured');
    }

    // Generate search variations
    const nameVariations = generateNameVariations(companyName);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Generated ${nameVariations.length} name variations`);
    
    let allResults: GooglePlaceSearchResult[] = [];
    const searchedQueries: string[] = [];
    
    // Step 1: Try multiple search queries to get comprehensive results
    // We'll try up to 3 variations to find the business
    const queriesToTry = [
      `${companyName} ${state}`,                    // Original with state
      `${extractCoreName(companyName)} ${state}`,   // Core name with state
      `${nameVariations[0]} roofing ${state}`,      // With industry keyword (if applicable)
    ].filter((q, i, arr) => arr.indexOf(q) === i); // Remove duplicates
    
    for (const searchQuery of queriesToTry.slice(0, 3)) {
      if (searchedQueries.includes(searchQuery)) continue;
      searchedQueries.push(searchQuery);
      
      console.log(`[GOOGLE_REVIEWS_DEBUG] Searching: "${searchQuery}"`);
      
      const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${googleApiKey}`;
      
      try {
        const searchResponse = await fetch(searchUrl);
        
        if (!searchResponse.ok) {
          console.error(`[GOOGLE_REVIEWS_DEBUG] Search failed for query: ${searchQuery}`);
          continue;
        }
        
        const searchData: GooglePlaceSearchResponse = await searchResponse.json();
        
        if (searchData.status === 'OK' && searchData.results) {
          // Add unique results
          for (const result of searchData.results) {
            if (!allResults.some(r => r.place_id === result.place_id)) {
              allResults.push(result);
            }
          }
          console.log(`[GOOGLE_REVIEWS_DEBUG] Found ${searchData.results.length} results (Total unique: ${allResults.length})`);
        }
      } catch (err) {
        console.error(`[GOOGLE_REVIEWS_DEBUG] Error in search query: ${searchQuery}`, err);
      }
    }
    
    if (allResults.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No results found after all search attempts`);
      return {
        success: false,
        message: "This company doesn't have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false,
        search_query: searchedQueries.join(' | ')
      };
    }

    console.log(`[GOOGLE_REVIEWS_DEBUG] Total unique results to evaluate: ${allResults.length}`);

    // Step 2: Find the best matching business using fuzzy matching
    const bestMatch = findBestMatch(companyName, allResults, 0.6);
    
    if (!bestMatch) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No suitable match found (min score: 0.6)`);
      return {
        success: false,
        message: "This company doesn't have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false,
        search_query: searchedQueries.join(' | ')
      };
    }

    console.log(`[GOOGLE_REVIEWS_DEBUG] Best match: "${bestMatch.business.name}" (Score: ${bestMatch.score.toFixed(3)}, Type: ${bestMatch.matchType})`);

    const placeId = bestMatch.business.place_id;
    
    // Step 3: Fetch detailed information including reviews
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,user_ratings_total,reviews,formatted_address,formatted_phone_number,website,address_components&key=${googleApiKey}`;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Fetching details for place_id: ${placeId}`);
    
    const detailsResponse = await fetch(detailsUrl);
    
    if (!detailsResponse.ok) {
      throw new Error(`Google Places Details API failed: ${detailsResponse.status} ${detailsResponse.statusText}`);
    }
    
    const detailsData: GooglePlaceDetailsResponse = await detailsResponse.json();
    
    if (detailsData.status !== 'OK') {
      throw new Error(`Google Places Details API error: ${detailsData.status} - ${detailsData.error_message || 'Unknown error'}`);
    }
    
    const placeDetails = detailsData.result;
    
    // Step 4: Verify the business is in the correct state
    const addressComponents = placeDetails.address_components || [];
    const stateComponent = addressComponents.find(c => c.types.includes('administrative_area_level_1'));
    const stateAbbreviations: { [key: string]: string } = {
      'Florida': 'FL',
      'California': 'CA',
      'Texas': 'TX',
      'New York': 'NY',
      // Add more as needed
    };
    const expectedStateAbbr = stateAbbreviations[state] || state;
    const isInCorrectState = stateComponent?.short_name === expectedStateAbbr || 
                             stateComponent?.long_name?.toLowerCase() === state.toLowerCase();
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Location verification:`, {
      formatted_address: placeDetails.formatted_address,
      state_found: stateComponent?.short_name || stateComponent?.long_name,
      expected_state: expectedStateAbbr,
      is_in_correct_state: isInCorrectState
    });

    if (!isInCorrectState) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Business "${placeDetails.name}" is not in ${state}.`);
      return {
        success: false,
        message: "This company doesn't have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false,
        search_query: searchedQueries.join(' | ')
      };
    }
    
    // Step 5: Process reviews data
    const reviews = placeDetails.reviews || [];
    const rating = placeDetails.rating || null;
    const totalRatings = placeDetails.user_ratings_total || 0;
    
    if (reviews.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Business found but no reviews: ${placeDetails.name}`);
      return {
        success: true,
        message: `Found "${placeDetails.name}" but no reviews available.`,
        rating: rating,
        total_ratings: totalRatings,
        reviews: [],
        business_found: true,
        business_name: placeDetails.name,
        business_address: placeDetails.formatted_address,
        business_phone: placeDetails.formatted_phone_number,
        business_website: placeDetails.website,
        place_id: placeId,
        match_type: bestMatch.matchType,
        match_score: bestMatch.score
      };
    }
    
    // Step 6: Categorize and sort reviews
    const processedReviews: ProcessedReview[] = reviews.map(review => ({
      author_name: review.author_name,
      rating: review.rating,
      text: review.text,
      time: review.time,
      relative_time_description: review.relative_time_description,
      profile_photo_url: review.profile_photo_url
    }));
    
    const sortedReviews = processedReviews.sort((a, b) => b.rating - a.rating);
    const positiveReviews = sortedReviews.filter(review => review.rating >= 4).slice(0, 3);
    const negativeReviews = sortedReviews.filter(review => review.rating <= 2).slice(0, 3);
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] SUCCESS: Found ${reviews.length} reviews for "${placeDetails.name}"`);
    
    return {
      success: true,
      message: `Successfully retrieved ${reviews.length} reviews for "${placeDetails.name}"`,
      rating: rating,
      total_ratings: totalRatings,
      reviews: {
        positive: positiveReviews,
        negative: negativeReviews,
        all: sortedReviews.slice(0, 10)
      },
      business_found: true,
      business_name: placeDetails.name,
      business_address: placeDetails.formatted_address,
      business_phone: placeDetails.formatted_phone_number,
      business_website: placeDetails.website,
      place_id: placeId,
      match_type: bestMatch.matchType,
      match_score: bestMatch.score
    };
    
  } catch (error) {
    console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR:`, error);
    return {
      success: false,
      error: (error as Error).message,
      message: "This company doesn't have any Google Reviews yet.",
      rating: null,
      reviews: [],
      business_found: false
    };
  }
}

// ============================================
// API HANDLER
// ============================================

/**
 * Main handler for the Google Reviews API endpoint
 */
export default async function handler(
  req: ApiRequest, 
  res: NextApiResponse<ReviewsData | { error: string; success: boolean; message?: string }>
) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      success: false 
    });
  }
  
  try {
    const { companyName, state = 'Florida' } = req.body;
    
    if (!companyName) {
      return res.status(400).json({ 
        error: 'Company name is required',
        success: false 
      });
    }
    
    const reviewsData = await fetchGoogleReviews(companyName, state);
    return res.status(200).json(reviewsData);
    
  } catch (error) {
    console.error(`[GOOGLE_REVIEWS_API_DEBUG] ERROR in handler:`, error);
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
      message: 'Internal server error while fetching Google Reviews',
    });
  }
}

// Export functions for use in other modules
export { fetchGoogleReviews, generateNameVariations, calculateMatchScore, extractCoreName };
