// Centralised event name constants. Snake_case, past-tense verbs, product-noun first.
// Keep this file the single source of truth so PostHog dashboards, funnels,
// and code stay in sync. Add new events here before capturing them.

export const AnalyticsEvent = {
  // Auth
  UserSignedUp: "user_signed_up",
  UserSignedIn: "user_signed_in",
  UserSignedOut: "user_signed_out",
  AccountDeleted: "account_deleted",

  // Route generation
  RouteGenerated: "route_generated",
  RouteGenerationFailed: "route_generation_failed",

  // Navigation lifecycle
  NavigationStarted: "route_started",
  RouteCompleted: "route_completed",
  RouteAbandoned: "route_abandoned",
  LocationError: "location_error",

  // Route CRUD & sharing
  RouteSaved: "route_saved",
  RouteDeleted: "route_deleted",
  RouteShared: "route_shared",
  RouteUnshared: "route_unshared",
  ShareLinkCopied: "share_link_copied",

  // Community
  CommunityRouteSaved: "community_route_saved",
  RouteLiked: "route_liked",
  RouteUnliked: "route_unliked",
  CommentPosted: "comment_posted",
  CommentDeleted: "comment_deleted",
  CommunityFeedSorted: "community_feed_sorted",

  // Feedback & ratings
  RouteRated: "route_rated",
  RouteFeedbackSubmitted: "route_feedback_submitted",

  // Premium — client
  PremiumCheckoutOpened: "premium_checkout_opened",
  PremiumCheckoutError: "premium_checkout_error",
  PremiumSubscriptionRestored: "premium_subscription_restored",
  PremiumSubscriptionCanceled: "premium_subscription_canceled",
  PremiumSubscriptionResumed: "premium_subscription_resumed",

  // Premium — authoritative server (webhook)
  PremiumSubscriptionCreatedWebhook: "premium_subscription_created",
  PremiumSubscriptionUpdatedWebhook: "premium_subscription_updated",
  PremiumSubscriptionCanceledWebhook: "premium_subscription_canceled_webhook",
  PremiumTrialStarted: "premium_trial_started",

  // Gates & errors
  FreeLimitReached: "free_limit_reached",
  PremiumGateHit: "premium_gate_hit",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];
