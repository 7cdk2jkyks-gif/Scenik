import { badgeFor } from "@/lib/badges";

export function BadgeGrid({ badgeKeys }: { badgeKeys: string[] }) {
  if (badgeKeys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No badges yet — plan and save your first route to get started.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {badgeKeys.map((key) => {
        const b = badgeFor(key);
        const Icon = b.icon;
        return (
          <div
            key={key}
            className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 text-center shadow-paper"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon className="h-6 w-6" />
            </div>
            <div>
              <div className="font-serif text-sm font-semibold text-ink">{b.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{b.description}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
