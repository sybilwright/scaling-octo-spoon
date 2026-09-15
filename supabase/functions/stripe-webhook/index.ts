// Stripe calls this whenever a payment or subscription event happens.
// Writes subscription_status on the matching profile using the service role
// key -- this is the ONLY place that's allowed to happen, by design (see the
// missing client update policy on profiles in supabase/schema.sql).
//
// Required secrets (set with `supabase secrets set`):
//   STRIPE_SECRET_KEY     -- same as create-checkout-session
//   STRIPE_WEBHOOK_SECRET -- from the Stripe webhook endpoint's settings, starts with whsec_
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// Inlined so this file can be pasted whole into the Supabase dashboard's
// Edge Function editor if you're not using the CLI.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminClient = createClient(supabaseUrl, serviceRoleKey);

async function setStatusByCustomerId(customerId: string, status: string) {
  const { error } = await adminClient
    .from("profiles")
    .update({ subscription_status: status })
    .eq("stripe_customer_id", customerId);
  if (error) console.error(`Failed to set ${customerId} to ${status}:`, error);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const signature = req.headers.get("stripe-signature");
  const body = await req.text(); // raw body -- required for signature verification, don't parse first

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook Error: ${String(err?.message ?? err)}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (typeof session.customer === "string") {
          await setStatusByCustomerId(session.customer, "active");
        }
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        if (typeof subscription.customer === "string") {
          await setStatusByCustomerId(subscription.customer, "canceled");
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        if (typeof invoice.customer === "string") {
          await setStatusByCustomerId(invoice.customer, "expired");
        }
        break;
      }
      case "invoice.payment_succeeded": {
        // Covers renewals after the first payment (checkout.session.completed only fires once).
        const invoice = event.data.object as Stripe.Invoice;
        if (typeof invoice.customer === "string" && invoice.billing_reason !== "subscription_create") {
          await setStatusByCustomerId(invoice.customer, "active");
        }
        break;
      }
      default:
        break; // ignore events we don't act on
    }
  } catch (err) {
    console.error("Error handling webhook event:", err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
