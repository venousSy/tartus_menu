import { Notice } from "./notice";

// Shown when the page calls notFound() for an unknown slug (UC-GUEST-001 A1).
export default function MenuNotFound() {
  return <Notice messageKey="notFound" />;
}
