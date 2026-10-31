import { ImageResponse } from "next/og";

import { brandMark } from "./brand-mark";

// The browser-tab icon of every page, and the two sizes an installable web app must list in its
// manifest (192 and 512). Served at /icon/192 and /icon/512, generated once at build time.
export function generateImageMetadata() {
  return [192, 512].map((side) => ({
    id: String(side),
    size: { width: side, height: side },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const side = Number(await id);
  return new ImageResponse(brandMark(side), { width: side, height: side });
}
