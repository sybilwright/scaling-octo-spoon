// See adding-user-accounts.md section 7. During beta every profile defaults to
// subscription_status = 'beta', so this always returns true until billing launches.
export function hasAccess(profile) {
  if (!profile) return false;
  if (profile.subscription_status === "beta") return true;
  if (profile.subscription_status === "active") return true;
  if (profile.subscription_status === "trialing") {
    return Boolean(profile.trial_ends_at) && new Date(profile.trial_ends_at) > new Date();
  }
  return false; // 'expired', 'canceled', or anything else
}
