// The app calls these functions from the browser (a different origin than
// the Supabase project), so every response needs CORS headers -- including
// error responses and the OPTIONS preflight.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};
