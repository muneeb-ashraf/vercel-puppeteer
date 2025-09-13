import { createClient } from '@supabase/supabase-js';
import { NextApiRequest, NextApiResponse } from 'next';

// Initialize Supabase client
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing required Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Type definitions
interface GooglePlaceSearchResult {
  place_id: string;
  name: string;
  rating?: number;
  user_ratings_total?: number;
  vicinity?: string;
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
  error?: string;
}

interface ApiRequest extends NextApiRequest {
  body: {
    companyName: string;
    state?: string;
  };
}

/**
 * Fetch Google Reviews for a business using Google Places API
 * Following the Stack Overflow approach: first get place_id, then fetch reviews
 * @param companyName - The name of the company to search for
 * @param state - The state to search in (default: Florida)
 * @returns Reviews data with rating and reviews
 */
async function fetchGoogleReviews(companyName: string, state: string = 'Florida'): Promise<ReviewsData> {
  try {
    console.log(`[GOOGLE_REVIEWS_DEBUG] Starting Google Reviews fetch for: "${companyName}" in ${state}`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Timestamp: ${new Date().toISOString()}`);
    
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!googleApiKey) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API key not configured`);
      console.log(`[GOOGLE_REVIEWS_DEBUG] Available env vars:`, Object.keys(process.env).filter(key => key.includes('GOOGLE') || key.includes('API')));
      throw new Error('Google Places API key not configured');
    }
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] API key found: ${googleApiKey.substring(0, 10)}...`);

    // Step 1: Search for the business using Text Search to get place_id
    // Use more restrictive search with location bias to Florida
    const searchQuery = `${companyName}`;
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&location=27.6648,-81.5158&radius=500000&region=us&key=${googleApiKey}`;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 1: Searching Google Places for place_id (Florida only)`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Search query: "${searchQuery}"`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Search URL: ${searchUrl.replace(googleApiKey, 'API_KEY_HIDDEN')}`);
    
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Google-Reviews-API/1.0'
      }
    });
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Search response status: ${searchResponse.status} ${searchResponse.statusText}`);
    
    if (!searchResponse.ok) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API search failed: ${searchResponse.status} ${searchResponse.statusText}`);
      throw new Error(`Google Places API search failed: ${searchResponse.status} ${searchResponse.statusText}`);
    }
    
    const searchData: GooglePlaceSearchResponse = await searchResponse.json();
    console.log(`[GOOGLE_REVIEWS_DEBUG] Google Places search response status: ${searchData.status}`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Search results count: ${searchData.results?.length || 0}`);
    
    if (searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API error: ${searchData.status} - ${searchData.error_message || 'Unknown error'}`);
      throw new Error(`Google Places API error: ${searchData.status} - ${searchData.error_message || 'Unknown error'}`);
    }
    
    if (!searchData.results || searchData.results.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No results found for "${companyName}" in Florida`);
      return {
        success: false,
        message: "There are no customer reviews available for this company.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }

    // Log all results for debugging
    console.log(`[GOOGLE_REVIEWS_DEBUG] All search results:`);
    searchData.results.forEach((result, index) => {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Result ${index + 1}:`, {
        name: result.name,
        place_id: result.place_id,
        rating: result.rating,
        user_ratings_total: result.user_ratings_total,
        vicinity: result.vicinity,
        types: result.types
      });
    });

    // Step 2: Find exact match for company name and verify it's in Florida
    const normalizeCompanyName = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[.,\-_'"]/g, '') // Remove common punctuation
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
    };

    const normalizedSearchName = normalizeCompanyName(companyName);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Normalized search name: "${normalizedSearchName}"`);

    let matchedBusiness: GooglePlaceSearchResult | null = null;

    // Look for exact match first
    for (const result of searchData.results) {
      const normalizedResultName = normalizeCompanyName(result.name);
      console.log(`[GOOGLE_REVIEWS_DEBUG] Comparing "${normalizedSearchName}" with "${normalizedResultName}"`);
      
      if (normalizedResultName === normalizedSearchName) {
        console.log(`[GOOGLE_REVIEWS_DEBUG] Found exact match: ${result.name}`);
        matchedBusiness = result;
        break;
      }
    }

    // If no exact match, check if any result contains the search term
    if (!matchedBusiness) {
      for (const result of searchData.results) {
        const normalizedResultName = normalizeCompanyName(result.name);
        
        if (normalizedResultName.includes(normalizedSearchName) || normalizedSearchName.includes(normalizedResultName)) {
          console.log(`[GOOGLE_REVIEWS_DEBUG] Found partial match: ${result.name}`);
          matchedBusiness = result;
          break;
        }
      }
    }

    if (!matchedBusiness) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No matching company found for "${companyName}"`);
      return {
        success: false,
        message: "There are no customer reviews available for this company.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }

    const business = matchedBusiness;
    const placeId = business.place_id;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 2: Found matching business: ${business.name} (Place ID: ${placeId})`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Business details:`, {
      name: business.name,
      rating: business.rating,
      user_ratings_total: business.user_ratings_total,
      vicinity: business.vicinity,
      types: business.types
    });
    
    // Step 3: Use place_id to fetch detailed information to verify Florida location
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,user_ratings_total,reviews,formatted_address,formatted_phone_number,website,address_components&key=${googleApiKey}`;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 3: Fetching detailed info for place_id: ${placeId}`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Details URL: ${detailsUrl.replace(googleApiKey, 'API_KEY_HIDDEN')}`);
    
    const detailsResponse = await fetch(detailsUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Google-Reviews-API/1.0'
      }
    });
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Details response status: ${detailsResponse.status} ${detailsResponse.statusText}`);
    
    if (!detailsResponse.ok) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places Details API failed: ${detailsResponse.status} ${detailsResponse.statusText}`);
      throw new Error(`Google Places Details API failed: ${detailsResponse.status} ${detailsResponse.statusText}`);
    }
    
    const detailsData: GooglePlaceDetailsResponse = await detailsResponse.json();
    console.log(`[GOOGLE_REVIEWS_DEBUG] Google Places details response status: ${detailsData.status}`);
    
    if (detailsData.status !== 'OK') {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places Details API error: ${detailsData.status} - ${detailsData.error_message || 'Unknown error'}`);
      throw new Error(`Google Places Details API error: ${detailsData.status} - ${detailsData.error_message || 'Unknown error'}`);
    }
    
    const placeDetails = detailsData.result;
    
    // Verify the business is actually in Florida
    const address = placeDetails.formatted_address || '';
    const isInFlorida = address.toLowerCase().includes('fl') || address.toLowerCase().includes('florida');
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Address verification:`, {
      formatted_address: address,
      is_in_florida: isInFlorida
    });

    if (!isInFlorida) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Business "${placeDetails.name}" is not located in Florida`);
      return {
        success: false,
        message: "There are no customer reviews available for this company.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }
    
    // Step 4: Process reviews data
    const reviews = placeDetails.reviews || [];
    const rating = placeDetails.rating || null;
    const totalRatings = placeDetails.user_ratings_total || 0;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 4: Processing reviews data`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Place details:`, {
      name: placeDetails.name,
      rating: rating,
      total_ratings: totalRatings,
      reviews_count: reviews.length,
      formatted_address: placeDetails.formatted_address,
      formatted_phone_number: placeDetails.formatted_phone_number,
      website: placeDetails.website
    });
    
    if (reviews.length > 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Sample review:`, {
        author_name: reviews[0].author_name,
        rating: reviews[0].rating,
        text_length: reviews[0].text?.length || 0,
        time: reviews[0].time
      });
    }
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Processing ${reviews.length} reviews for ${placeDetails.name}`);
    
    if (reviews.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No reviews found for business: ${placeDetails.name}`);
      return {
        success: false,
        message: "There are no customer reviews available for this company.",
        rating: rating,
        total_ratings: totalRatings,
        reviews: [],
        business_found: true,
        business_name: placeDetails.name,
        business_address: placeDetails.formatted_address,
        business_phone: placeDetails.formatted_phone_number,
        business_website: placeDetails.website,
        place_id: placeId
      };
    }
    
    // Step 5: Categorize and sort reviews
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 5: Processing and categorizing reviews`);
    
    const processedReviews: ProcessedReview[] = reviews.map(review => ({
      author_name: review.author_name,
      rating: review.rating,
      text: review.text,
      time: review.time,
      relative_time_description: review.relative_time_description,
      profile_photo_url: review.profile_photo_url
    }));
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Processed ${processedReviews.length} reviews`);
    
    // Sort reviews by rating (highest first)
    const sortedReviews = processedReviews.sort((a, b) => b.rating - a.rating);
    
    // Get top positive reviews (rating >= 4)
    const positiveReviews = sortedReviews.filter(review => review.rating >= 4).slice(0, 3);
    
    // Get top negative reviews (rating <= 2)
    const negativeReviews = sortedReviews.filter(review => review.rating <= 2).slice(0, 3);
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Successfully processed ${sortedReviews.length} reviews (${positiveReviews.length} positive, ${negativeReviews.length} negative)`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Rating distribution:`, {
      '5 stars': sortedReviews.filter(r => r.rating === 5).length,
      '4 stars': sortedReviews.filter(r => r.rating === 4).length,
      '3 stars': sortedReviews.filter(r => r.rating === 3).length,
      '2 stars': sortedReviews.filter(r => r.rating === 2).length,
      '1 star': sortedReviews.filter(r => r.rating === 1).length
    });
    
    const finalResult: ReviewsData = {
      success: true,
      message: `Successfully retrieved reviews for "${placeDetails.name}"`,
      rating: rating,
      total_ratings: totalRatings,
      reviews: {
        positive: positiveReviews,
        negative: negativeReviews,
        all: sortedReviews.slice(0, 10) // Top 10 reviews overall
      },
      business_found: true,
      business_name: placeDetails.name,
      business_address: placeDetails.formatted_address,
      business_phone: placeDetails.formatted_phone_number,
      business_website: placeDetails.website,
      search_query: searchQuery,
      place_id: placeId
    };
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Final result summary:`, {
      success: finalResult.success,
      business_found: finalResult.business_found,
      rating: finalResult.rating,
      total_ratings: finalResult.total_ratings,
      positive_reviews: (finalResult.reviews as any).positive.length,
      negative_reviews: (finalResult.reviews as any).negative.length,
      all_reviews: (finalResult.reviews as any).all.length,
      business_name: finalResult.business_name
    });
    
    return finalResult;
    
  } catch (error) {
    console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Error fetching Google Reviews:`, error);
    console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Stack trace:`, (error as Error).stack);
    return {
      success: false,
      error: (error as Error).message,
      message: "There are no customer reviews available for this company.",
      rating: null,
      reviews: [],
      business_found: false
    };
  }
}

/**
 * Main handler for the Google Reviews API endpoint
 */
export default async function handler(req: ApiRequest, res: NextApiResponse<ReviewsData | { error: string; success: boolean; message?: string; debug?: any }>) {
  console.log(`[GOOGLE_REVIEWS_API_DEBUG] Handler called with method: ${req.method}`);
  console.log(`[GOOGLE_REVIEWS_API_DEBUG] Request URL: ${req.url}`);
  console.log(`[GOOGLE_REVIEWS_API_DEBUG] Request headers:`, req.headers);
  console.log(`[GOOGLE_REVIEWS_API_DEBUG] Timestamp: ${new Date().toISOString()}`);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] Handling OPTIONS request`);
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] ERROR: Method ${req.method} not allowed, returning 405`);
    return res.status(405).json({ 
      error: 'Method not allowed',
      message: `Only POST method is supported, received: ${req.method}`,
      success: false,
      debug: {
        method: req.method,
        url: req.url,
        headers: req.headers
      }
    });
  }
  
  try {
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] Request body:`, JSON.stringify(req.body, null, 2));
    const { companyName, state = 'Florida' } = req.body;
    
    if (!companyName) {
      console.log(`[GOOGLE_REVIEWS_API_DEBUG] ERROR: Company name is missing from request body`);
      return res.status(400).json({ 
        error: 'Company name is required',
        success: false 
      });
    }
    
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] Processing request for: "${companyName}" in ${state}`);
    
    // Check if Google Places API key is configured
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      console.error(`[GOOGLE_REVIEWS_API_DEBUG] ERROR: GOOGLE_PLACES_API_KEY environment variable is not set`);
      console.log(`[GOOGLE_REVIEWS_API_DEBUG] Available environment variables:`, Object.keys(process.env).filter(key => key.includes('GOOGLE') || key.includes('API')));
      return res.status(500).json({
        success: false,
        error: 'Google Places API key not configured',
        message: 'Server configuration error: Google Places API key is missing',
        debug: {
          hasApiKey: !!process.env.GOOGLE_PLACES_API_KEY,
          availableEnvVars: Object.keys(process.env).filter(key => key.includes('GOOGLE') || key.includes('API'))
        }
      });
    }
    
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] API key is configured, calling fetchGoogleReviews...`);
    const reviewsData = await fetchGoogleReviews(companyName, state);
    
    // Log the result for debugging
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] Google Reviews result:`, {
      success: reviewsData.success,
      business_found: reviewsData.business_found,
      rating: reviewsData.rating,
      reviews_count: Array.isArray(reviewsData.reviews) ? reviewsData.reviews.length : (reviewsData.reviews as any).all?.length || 0,
      place_id: reviewsData.place_id,
      error: reviewsData.error
    });
    
    console.log(`[GOOGLE_REVIEWS_API_DEBUG] Returning response with status 200`);
    return res.status(200).json(reviewsData);
    
  } catch (error) {
    console.error(`[GOOGLE_REVIEWS_API_DEBUG] ERROR: Google Reviews API error:`, error);
    console.error(`[GOOGLE_REVIEWS_API_DEBUG] ERROR: Stack trace:`, (error as Error).stack);
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
      message: 'Internal server error while fetching Google Reviews',
    });
  }
}

// Export the fetch function for use in other modules
export { fetchGoogleReviews };