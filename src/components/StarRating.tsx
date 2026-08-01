import { Star } from "lucide-react";
import { useState } from "react";

interface StarRatingProps {
  value: number; // current user's rating (0 = not rated)
  onChange?: (rating: number) => void;
  size?: number;
  readOnly?: boolean;
  className?: string;
}

export function StarRating({ value, onChange, size = 18, readOnly = false, className = "" }: StarRatingProps) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div className={`inline-flex items-center gap-0.5 ${className}`} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            disabled={readOnly}
            onMouseEnter={() => !readOnly && setHover(n)}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!readOnly) onChange?.(n);
            }}
            className={`${readOnly ? "cursor-default" : "cursor-pointer hover:scale-110"} transition-transform`}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            <Star
              style={{ width: size, height: size }}
              className={filled ? "fill-amber-400 text-amber-400" : "fill-none text-muted-foreground/40"}
              strokeWidth={1.5}
            />
          </button>
        );
      })}
    </div>
  );
}

export function RatingDisplay({ avg, count, size = 14 }: { avg: number; count: number; size?: number }) {
  if (!count) {
    return <span className="text-[10px] text-muted-foreground">No ratings yet</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink">
      <Star style={{ width: size, height: size }} className="fill-amber-400 text-amber-400" strokeWidth={1.5} />
      <span className="font-medium">{Number(avg).toFixed(1)}</span>
      <span className="text-muted-foreground">({count})</span>
    </span>
  );
}
