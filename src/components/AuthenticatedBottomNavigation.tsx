import { Link } from "@tanstack/react-router";
import { Map, Navigation, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AuthenticatedBottomNavigation() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur"
    >
      <div className="mx-auto grid max-w-lg grid-cols-4 items-center gap-1 px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1.5 sm:px-6">
        {[
          { to: "/plan" as const, label: "Plan", Icon: Navigation },
          { to: "/routes" as const, label: "Routes", accessibleLabel: "My routes", Icon: Map },
          {
            to: "/community" as const,
            label: "Explore",
            accessibleLabel: "Explore community routes",
            Icon: Users,
          },
          { to: "/settings" as const, label: "Settings", Icon: Settings },
        ].map(({ to, label, accessibleLabel, Icon }) => (
          <Link key={to} to={to} className="flex-1" activeOptions={{ includeSearch: false }}>
            {({ isActive }) => (
              <Button
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className="h-auto w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-[10px] sm:flex-row sm:gap-1.5 sm:text-xs"
                aria-label={accessibleLabel ?? label}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Button>
            )}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export const AUTHENTICATED_PAGE_BOTTOM_PADDING = "calc(5rem + env(safe-area-inset-bottom))";

export function CommunityBottomNavigation({ authenticated }: { authenticated: boolean }) {
  return authenticated ? <AuthenticatedBottomNavigation /> : null;
}
