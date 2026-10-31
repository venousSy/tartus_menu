// The platform's brown. Keep it equal to --color-primary in globals.css: ImageResponse cannot read
// CSS variables, so the icons need the value itself.
export const BRAND_COLOR = "#6f4e37";

/**
 * The platform's app icon, the same for every cafe: a white coffee cup on the brand brown. It is a
 * JSX element for ImageResponse (next/og), which supports flexbox and inline SVG, not Tailwind.
 */
export function brandMark(side: number) {
  // The cup fills the middle 60%: Android may crop an installed app's icon to a circle (80% wide).
  const cup = Math.round(side * 0.6);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND_COLOR,
      }}
    >
      <svg
        width={cup}
        height={cup}
        viewBox="0 0 64 64"
        fill="none"
        stroke="#ffffff"
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Steam, cup, handle, saucer. Comments stay on their own lines: a space next to an element
            would become a text node inside the <svg>. */}
        <path d="M24 6c-3 4 3 7 0 11M34 6c-3 4 3 7 0 11" />
        <path d="M12 24h36v10a18 18 0 0 1-36 0z" fill="#ffffff" />
        <path d="M48 28h3a7 7 0 0 1 0 14h-5" />
        <path d="M8 58h44" />
      </svg>
    </div>
  );
}
