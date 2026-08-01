import { getPaddleEnvironment } from "@/lib/paddle";

export function PaymentTestModeBanner() {
  if (getPaddleEnvironment() !== "sandbox") return null;
  return (
    <div className="w-full bg-orange-100 border-b border-orange-300 px-3 py-1.5 text-center text-xs text-orange-800 sm:px-4 sm:py-2 sm:text-sm">
      <span className="sm:hidden">Test mode · card <span className="font-mono">4242 4242 4242 4242</span></span>
      <span className="hidden sm:inline">Payments are in test mode. Use card <span className="font-mono">4242 4242 4242 4242</span>, any future expiry, any CVC.</span>
    </div>
  );
}
