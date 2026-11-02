import type { Role } from "@/lib/server/session";

/** The first page of each role: proxy.ts sends signed-in users there, and so does the login form. */
export const HOME: Record<Role, string> = { CAFE_OWNER: "/dashboard", SYSTEM_ADMIN: "/admin" };
