/**
 * Stat Card
 *
 * Metric panel with label, value, and optional trend.
 *
 * The label is a Space Mono eyebrow and the value uses tabular figures so a
 * row of cards keeps its rhythm as numbers update. Trend keeps an arrow
 * alongside the colour, because colour alone is not an accessible signal.
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
}

export default function StatCard({ label, value, trend, trendUp }: StatCardProps) {
  return (
    <div className="panel p-5">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-2 text-3xl font-semibold text-foreground">
        {value}
      </p>
      {trend && (
        <p
          className={`mt-1.5 text-xs font-medium ${
            trendUp ? "text-success" : "text-error"
          }`}
        >
          <span aria-hidden="true">{trendUp ? "↑" : "↓"}</span> {trend}
        </p>
      )}
    </div>
  );
}
