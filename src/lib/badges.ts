import { Award, Flame, Heart, Map, Mountain, Star, Trophy } from "lucide-react";

export type BadgeDef = {
  key: string;
  name: string;
  description: string;
  icon: typeof Award;
  category: "milestone" | "community" | "explorer" | "streak";
};

export const KNOWN_BADGES: BadgeDef[] = [
  { key: "first_route", name: "First Route", description: "Saved your first Scenik.", icon: Star, category: "milestone" },
  { key: "ten_routes", name: "Wayfarer", description: "10 routes saved.", icon: Map, category: "milestone" },
  { key: "fifty_routes", name: "Roadmaster", description: "50 routes saved.", icon: Trophy, category: "milestone" },
  { key: "hundred_routes", name: "Century Driver", description: "100 routes saved.", icon: Award, category: "milestone" },
  { key: "first_share", name: "First Share", description: "Your first route got a like.", icon: Heart, category: "community" },
  { key: "ten_likes", name: "Crowd Pleaser", description: "10 likes on your routes.", icon: Star, category: "community" },
  { key: "fifty_likes", name: "Community Favourite", description: "50 likes on your routes.", icon: Flame, category: "community" },
];

export function badgeFor(key: string): BadgeDef {
  const known = KNOWN_BADGES.find((b) => b.key === key);
  if (known) return known;
  // Explorer/theme badges: dynamic
  if (key.startsWith("theme_")) {
    const theme = key.replace(/^theme_/, "").replace(/_/g, " ");
    const label = theme.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      key,
      name: `${label} Explorer`,
      description: `Completed 5 ${label.toLowerCase()} routes.`,
      icon: Mountain,
      category: "explorer",
    };
  }
  return { key, name: key, description: "Badge earned.", icon: Award, category: "milestone" };
}
