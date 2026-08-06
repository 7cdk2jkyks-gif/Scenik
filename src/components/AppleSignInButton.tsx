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
      <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
        <img
          src="/assets/sign-in-with-apple-logo.png"
          alt=""
          className="block h-5 w-5 object-contain"
          width={20}
          height={20}
        />
      </span>
      {label}
    </Button>
  );
}
