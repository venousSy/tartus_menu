/**
 * Black or white text, whichever is easier to read on the background color "#RRGGBB".
 * An owner may pick a light primary color; white text on light yellow would be unreadable.
 * Uses the WCAG relative luminance and contrast ratio formulas.
 */
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? "#000000" : "#ffffff";
}
