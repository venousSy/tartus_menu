import { redirect } from "next/navigation";

// The bare domain has no page of its own: customers open /menu/<slug> from a QR code, and owners and
// the Super Admin sign in. /login itself sends a visitor who is already logged in to their dashboard
// (proxy.ts).
export default function Home(): never {
  redirect("/login");
}
