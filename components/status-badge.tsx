/**
 * Status label for DM status.
 *
 * Rendered as a pill (the brand's 999px radius) with a tinted ground rather
 * than bare coloured text, so a column of statuses is scannable at a glance.
 * The written label always carries the meaning — colour is reinforcement, not
 * the signal, which keeps it readable for colour-blind users.
 */

const statusConfig: Record<string, { className: string; label: string }> = {
  SENT: {
    className: "bg-success/10 text-success",
    label: "Sent",
  },
  FAILED: {
    className: "bg-error/10 text-error",
    label: "Failed",
  },
  PENDING: {
    className: "bg-warning/10 text-warning",
    label: "Pending",
  },
  SKIPPED_DEDUP: {
    className: "bg-foreground/[0.06] text-muted",
    label: "Dedup",
  },
  SKIPPED_RATE_LIMIT: {
    className: "bg-warning/10 text-warning",
    label: "Rate limited",
  },
  SKIPPED_PLAN_LIMIT: {
    className: "bg-warning/10 text-warning",
    label: "Skipped",
  },
  SKIPPED_NO_MATCH: {
    className: "bg-foreground/[0.06] text-muted",
    label: "No match",
  },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.PENDING;

  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
