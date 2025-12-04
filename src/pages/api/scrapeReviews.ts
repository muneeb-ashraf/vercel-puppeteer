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
 * Extract core business name (without suffixes)
 */
function extractCoreName(name: string): string {
  let coreName = normalizeCompanyName(name);
  coreName = removeBusinessSuffixes(coreName);
  return coreName.trim();
}

/**
 * Generate multiple variations of a company name for searching
 * Only adds common business suffixes to the original name
 */
function generateNameVariations(companyName: string): string[] {
  const variations = new Set<string>();
  const normalized = normalizeCompanyName(companyName);
  
  // 1. Original normalized name
  variations.add(normalized);
  
  // 2. Add common business suffixes to original name
  const commonSuffixes = ['llc', 'inc', 'corp', 'co', 'ltd', 'limited'];
  for (const suffix of commonSuffixes) {
    variations.add(`${normalized} ${suffix}`);
  }
  
  // Convert to array and filter empty strings
  return Array.from(variations).filter(v => v.length > 0);
}

/**
 * Calculate a simplified match score between search name and result name
 * Only allows exact matches or core name matches
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
  
  // 2. Core name exact match (only difference is suffix like LLC, Inc, etc.)
  if (searchCore === resultCore && searchCore.length > 0) {
    return { score: 0.95, matchType: 'core_exact' };
  }
  
  // No match
  return { score: 0.0, matchType: 'no_match' };
}

/**
 * Find the best matching business from search results
 */
function findBestMatch(
  searchName: string, 
  results: GooglePlaceSearchResult[], 
  minScore: number = 0.9
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
    
    // Step 1: Search with original company name + state
    const searchQuery = `${companyName} ${state}`;
    searchedQueries.push(searchQuery);
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Searching: "${searchQuery}"`);
    
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${googleApiKey}`;
    
    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      throw new Error(`Google Places Search API failed: ${searchResponse.status} ${searchResponse.statusText}`);
    }
    
    const searchData: GooglePlaceSearchResponse = await searchResponse.json();
    
    if (searchData.status !== 'OK' || !searchData.results || searchData.results.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No results found`);
      return {
        success: false,
        message: "This company doesn't have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false,
        search_query: searchQuery
      };
    }
    
    allResults = searchData.results;
    console.log(`[GOOGLE_REVIEWS_DEBUG] Found ${allResults.length} results`);

    // Step 2: Find the best matching business using exact matching only
    const bestMatch = findBestMatch(companyName, allResults, 0.9);
    
    if (!bestMatch) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No exact match found (min score: 0.9)`);
      return {
        success: false,
        message: "This company doesn't have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false,
        search_query: searchQuery
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
        search_query: searchQuery
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
