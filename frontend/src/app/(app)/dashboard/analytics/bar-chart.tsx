/** One bar: its place on the axis (`label`), its number, and the full text for the table and the tooltip (`name`). */
export type Bar = { label: string; name: string; value: number };

// The drawing's own units: each bar gets a 10-wide slot, the plot is 40 high.
const SLOT = 10;
const HEIGHT = 40;

/**
 * A bar chart in plain SVG, without a chart library (nothing to download, no JavaScript in the
 * browser). Time always runs left to right, also on an Arabic page (dir="ltr"), like the numbers
 * themselves (GC 10). Screen readers get the same numbers as a table; the drawing is hidden from them.
 */
export function BarChart({ caption, columns, bars }: { caption: string; columns: [string, string]; bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  // At most about 8 labels under the axis, so they never overlap: every bar for a week, every 13th for 90 days.
  const step = Math.ceil(bars.length / 8);
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-4">
      <figcaption className="font-semibold">{caption}</figcaption>
      <div dir="ltr" aria-hidden="true" className="flex flex-col gap-1">
        <span className="text-xs text-stone-600">{max}</span>
        <svg viewBox={`0 0 ${bars.length * SLOT} ${HEIGHT}`} preserveAspectRatio="none"
          className="h-40 w-full border-b border-stone-300 text-primary">
          {bars.map((bar, index) => {
            // A bar with opens is at least a visible line; a bar without any is not drawn.
            const height = bar.value === 0 ? 0 : Math.max(0.6, (bar.value / max) * HEIGHT);
            return (
              <rect key={index} x={index * SLOT + 1} y={HEIGHT - height} width={SLOT - 2} height={height} fill="currentColor">
                <title>{`${bar.name}: ${bar.value}`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="flex text-center text-xs text-stone-600">
          {bars.map((bar, index) => (
            <span key={index} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
              {index % step === 0 ? bar.label : ""}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr><th scope="col">{columns[0]}</th><th scope="col">{columns[1]}</th></tr>
        </thead>
        <tbody>
          {bars.map((bar, index) => (
            <tr key={index}><th scope="row">{bar.name}</th><td>{bar.value}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
