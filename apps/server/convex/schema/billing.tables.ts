import { defineTable } from "convex/server";
import { v } from "convex/values";

export const subscriptionTables = {
  // A team's seat plan (teamBilling.ts, lib/teamSeats.ts): no row, or a row
  // without a live subscription, is the free Starter plan; a live Stripe
  // subscription on the per-seat price is Pro. The Stripe fields are a copy
  // of the subscription as last read from Stripe (`subscription_read_at`);
  // Stripe's events only prompt a re-read. Server only: no query returns the
  // row, so Stripe ids never reach a member's client.
  team_subscriptions: defineTable({
    team_id: v.id("teams"),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    subscription_status: v.optional(v.string()),
    price_id: v.optional(v.string()),
    quantity: v.optional(v.number()),
    trial_end: v.optional(v.number()),
    current_period_end: v.optional(v.number()),
    cancel_at_period_end: v.optional(v.boolean()),
    subscription_read_at: v.optional(v.number()),
    // A Stripe read for this team failed for a reason that may pass (network,
    // 5xx). Newer than `subscription_read_at`: the plan is unconfirmed, and
    // the seat gate fails open.
    refresh_failed_at: v.optional(v.number()),
    // An admin opened checkout; until its subscription lands the gate fails
    // open, up to the seats that checkout is for (`checkout_seats`).
    checkout_started_at: v.optional(v.number()),
    checkout_seats: v.optional(v.number()),
    // The team was already over the free capacity when seat billing first
    // judged it: it keeps adding seats without a plan.
    grandfathered_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_customer", ["stripe_customer_id"]),
};

export const usageCalibrationTables = {
  // One row ("global"): how many cost-weighted tokens one percentage point of a
  // 5h session window is worth. The provider publishes utilization as a percent
  // and never a size, so this rate is FITTED from our own traffic against our own
  // meters (usageCalibration.ts) and refreshed on a cron. `recent` holds the last
  // samples so one odd window cannot move the published median.
  usage_calibration: defineTable({
    key: v.literal("global"),
    tokens_per_percent: v.optional(v.number()),
    samples: v.optional(v.number()),
    recent: v.optional(v.array(v.number())),
    updated_at: v.number(),
    // Why the last run kept or dropped each user, so a rate that never moves can
    // be diagnosed from the row instead of by instrumenting the job again.
    last_run: v.optional(
      v.object({
        users: v.number(),
        added: v.number(),
        unpaired: v.number(),
        below_floor: v.number(),
        no_tokens: v.number(),
        best_rise: v.number(),
      }),
    ),
    // The previous reading, which the next run diffs against: when it was taken
    // and, per user, the utilization of every window their devices reported.
    last_sample: v.optional(
      v.object({
        at: v.number(),
        slot: v.number(),
        users: v.array(
          v.object({
            user_id: v.id("users"),
            windows: v.array(
              v.object({
                key: v.string(),
                percent: v.number(),
                resets_at: v.optional(v.number()),
                // When that account was last polled: a window nobody re-read between
                // two runs cannot testify about the traffic between them.
                fetched_at: v.optional(v.number()),
              }),
            ),
          }),
        ),
      }),
    ),
  }).index("by_key", ["key"]),
};
