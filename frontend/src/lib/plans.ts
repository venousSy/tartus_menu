// The subscription plans a Super Admin can choose (create and edit forms).

/**
 * The plan codes of the SubscriptionPlan rows (system_design.md §2.2: 'basic' | 'pro'). There is no
 * endpoint that lists them; an unknown code is refused by Django (UC-ADMIN-001 A3).
 */
export const PLAN_CODES = ["basic", "pro"] as const;
