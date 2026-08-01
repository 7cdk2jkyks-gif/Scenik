import { Button } from "@/components/ui/button";

export function AppleSignInButton({
  onClick,
  disabled,
  label = "Continue with Apple",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="mt-3 w-full bg-black text-white hover:bg-black/90 hover:text-white"
      onClick={onClick}
      disabled={disabled}
    >
      <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden fill="currentColor">
        <path d="M16.365 1.43c0 1.14-.46 2.24-1.21 3.04-.8.86-2.11 1.52-3.19 1.43-.14-1.09.4-2.24 1.12-3.02.8-.87 2.18-1.53 3.28-1.45zM20.5 17.36c-.55 1.28-.82 1.85-1.53 2.98-.99 1.57-2.39 3.53-4.12 3.55-1.54.02-1.93-1.01-4.02-1-2.1.01-2.53 1.02-4.06 1-1.73-.02-3.05-1.79-4.05-3.36C-.09 16.9-.4 11.83 2.06 9.06c1.44-1.63 3.72-2.66 5.86-2.66 2.18 0 3.55 1.19 5.36 1.19 1.75 0 2.82-1.2 5.34-1.2 1.91 0 3.94 1.04 5.38 2.84-4.72 2.58-3.94 9.32-3.5 8.13z" />
      </svg>
      {label}
    </Button>
  );
}
