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
 * @param companyName - The name of the company to search for
 * @param state - The state to search in (default: Florida)
 * @returns Reviews data with rating and reviews
 */
async function fetchGoogleReviews(companyName: string, state: string = 'Florida'): Promise<ReviewsData> {
  try {
    console.log(`[GOOGLE_REVIEWS_DEBUG] Starting Google Reviews fetch for: "${companyName}" in ${state}`);
    const googleApiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!googleApiKey) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API key not configured`);
      throw new Error('Google Places API key not configured');
    }

    // Step 1: Search for the business using Text Search to get place_id
    // FIX: Add "Florida" to the query to make the search more specific and geographically constrained.
    const searchQuery = `${companyName} Florida`;
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${googleApiKey}`;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 1: Searching Google Places for place_id.`);
    console.log(`[GOOGLE_REVIEWS_DEBUG] Search query: "${searchQuery}"`);
    
    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API search failed: ${searchResponse.status} ${searchResponse.statusText}`);
      throw new Error(`Google Places API search failed: ${searchResponse.status} ${searchResponse.statusText}`);
    }
    
    const searchData: GooglePlaceSearchResponse = await searchResponse.json();
    
    if (searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
      console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Google Places API error: ${searchData.status} - ${searchData.error_message || 'Unknown error'}`);
      throw new Error(`Google Places API error: ${searchData.status} - ${searchData.error_message || 'Unknown error'}`);
    }
    
    if (!searchData.results || searchData.results.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No results found for "${companyName}" in Florida`);
      // FIX: Updated message as per user request.
      return {
        success: false,
        message: "This company doesn’t have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }

    // Step 2: Find exact match for company name
    const normalizeCompanyName = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[.,\-_'"]/g, '') // Remove common punctuation
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
    };

    const normalizedSearchName = normalizeCompanyName(companyName);
    let matchedBusiness: GooglePlaceSearchResult | null = null;

    // Look for an exact match only.
    for (const result of searchData.results) {
      const normalizedResultName = normalizeCompanyName(result.name);
      if (normalizedResultName === normalizedSearchName) {
        console.log(`[GOOGLE_REVIEWS_DEBUG] Found exact match: ${result.name}`);
        matchedBusiness = result;
        break; // Stop after finding the first exact match
      }
    }

    // FIX: Removed the fallback to partial/loose matching.
    // If no exact match is found after checking all results, exit.
    if (!matchedBusiness) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No exact match found for "${companyName}"`);
      // FIX: Updated message as per user request.
      return {
        success: false,
        message: "This company doesn’t have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }

    const placeId = matchedBusiness.place_id;
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 2: Found matching business: ${matchedBusiness.name} (Place ID: ${placeId})`);
    
    // Step 3: Use place_id to fetch detailed information to verify Florida location
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,user_ratings_total,reviews,formatted_address,address_components&key=${googleApiKey}`;
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Step 3: Fetching detailed info for place_id: ${placeId}`);
    
    const detailsResponse = await fetch(detailsUrl);
    
    if (!detailsResponse.ok) {
      throw new Error(`Google Places Details API failed: ${detailsResponse.status} ${detailsResponse.statusText}`);
    }
    
    const detailsData: GooglePlaceDetailsResponse = await detailsResponse.json();
    
    if (detailsData.status !== 'OK') {
      throw new Error(`Google Places Details API error: ${detailsData.status} - ${detailsData.error_message || 'Unknown error'}`);
    }
    
    const placeDetails = detailsData.result;
    
    // FIX: Verify the business is in Florida using address_components for better accuracy.
    const addressComponents = placeDetails.address_components || [];
    const stateComponent = addressComponents.find(c => c.types.includes('administrative_area_level_1'));
    const isInFlorida = stateComponent?.short_name === 'FL';
    
    console.log(`[GOOGLE_REVIEWS_DEBUG] Address verification:`, {
        formatted_address: placeDetails.formatted_address,
        state_short_name: stateComponent?.short_name,
        is_in_florida: isInFlorida
    });

    if (!isInFlorida) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] Business "${placeDetails.name}" is not located in Florida.`);
      // FIX: Updated message as per user request.
      return {
        success: false,
        message: "This company doesn’t have any Google Reviews yet.",
        rating: null,
        reviews: [],
        business_found: false
      };
    }
    
    // Step 4: Process reviews data
    const reviews = placeDetails.reviews || [];
    const rating = placeDetails.rating || null;
    const totalRatings = placeDetails.user_ratings_total || 0;
    
    if (reviews.length === 0) {
      console.log(`[GOOGLE_REVIEWS_DEBUG] No reviews found for business: ${placeDetails.name}`);
      // FIX: Updated message. Success is true because we found the business, it just has no reviews.
      return {
        success: true,
        message: "This company doesn’t have any Google Reviews yet.",
        rating: rating,
        total_ratings: totalRatings,
        reviews: [],
        business_found: true,
        business_name: placeDetails.name,
        business_address: placeDetails.formatted_address,
        place_id: placeId
      };
    }
    
    // Step 5: Categorize and sort reviews
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
    
    return {
      success: true,
      message: `Successfully retrieved reviews for "${placeDetails.name}"`,
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
      place_id: placeId
    };
    
  } catch (error) {
    console.error(`[GOOGLE_REVIEWS_DEBUG] ERROR: Error fetching Google Reviews:`, error);
    // FIX: Updated message as per user request.
    return {
      success: false,
      error: (error as Error).message,
      message: "This company doesn’t have any Google Reviews yet.",
      rating: null,
      reviews: [],
      business_found: false
    };
  }
}

/**
 * Main handler for the Google Reviews API endpoint
 */
export default async function handler(req: ApiRequest, res: NextApiResponse<ReviewsData | { error: string; success: boolean; message?: string }>) {
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

// Export the fetch function for use in other modules
export { fetchGoogleReviews };
