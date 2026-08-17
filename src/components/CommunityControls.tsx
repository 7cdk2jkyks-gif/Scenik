import type { ReactNode } from "react";
import { Heart } from "lucide-react";

export type CommunitySort = "new" | "top" | "rated";

export function CommunityLikeButton({
  title,
  count,
  isLiked,
  onToggle,
  variant = "card",
}: {
  title: string;
  count: number;
  isLiked: boolean;
  onToggle: () => void;
  variant?: "card" | "detail";
}) {
  const className =
    variant === "detail"
      ? `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
          isLiked
            ? "border-rose-500 bg-rose-50 text-rose-700"
            : "border-border bg-background text-ink hover:border-rose-300"
        }`
      : `inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition ${
          isLiked ? "text-rose-600" : "hover:text-rose-600"
        }`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${isLiked ? "Unlike" : "Like"} ${title}`}
      aria-pressed={isLiked}
      className={className}
    >
      <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} aria-hidden="true" />
      {count}
    </button>
  );
}

export function CommunityFeedFooter({
  creator,
  title,
  likeCount,
  isLiked,
  onToggleLike,
}: {
  creator: ReactNode;
  title: string;
  likeCount: number;
  isLiked: boolean;
  onToggleLike: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      {creator}
      <CommunityLikeButton
        title={title}
        count={likeCount}
        isLiked={isLiked}
        onToggle={onToggleLike}
      />
    </div>
  );
}

export function CommunitySortControls({
  value,
  onChange,
}: {
  value: CommunitySort;
  onChange: (sort: CommunitySort) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 rounded-full border border-border bg-background p-1">
      {(["new", "top", "rated"] as const).map((sort) => (
        <button
          key={sort}
          type="button"
          aria-pressed={value === sort}
          onClick={() => onChange(sort)}
          className={`rounded-full px-4 py-1 text-xs font-medium transition ${
            value === sort
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-ink"
          }`}
        >
          {sort === "new" ? "New" : sort === "top" ? "Most loved" : "Top rated"}
        </button>
      ))}
    </div>
  );
}
