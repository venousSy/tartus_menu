import { ImageResponse } from "next/og";

import { brandMark } from "./brand-mark";

// The home-screen icon on iPhones and iPads. iOS rounds the corners itself and shows black where an
// icon is transparent, so the brown fills the whole square.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(brandMark(size.width), size);
}
