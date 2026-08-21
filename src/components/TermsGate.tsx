import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Logo } from "@/components/Logo";
import { getMyProfile, acceptTerms } from "@/lib/profiles.functions";
import { toast } from "sonner";

export function ConsentAgreement({
  agreed,
  onAgreedChange,
}: {
  agreed: boolean;
  onAgreedChange(agreed: boolean): void;
}) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
      <label htmlFor="agree" className="flex h-11 w-11 shrink-0 items-start justify-center pt-0.5">
        <Checkbox
          id="agree"
          required
          aria-labelledby="agree-label"
          checked={agreed}
          onCheckedChange={(value) => onAgreedChange(value === true)}
          className="h-[26px] w-[26px] rounded-full [&_svg]:h-4 [&_svg]:w-4"
        />
      </label>
      <span id="agree-label" className="min-w-0 pt-1 text-ink/85">
        I have read and agree to the{" "}
        <Link to="/terms" target="_blank" rel="noreferrer" className="text-primary underline">
          Terms &amp; Conditions
        </Link>{" "}
        and{" "}
        <Link to="/privacy" target="_blank" rel="noreferrer" className="text-primary underline">
          Privacy Notice
        </Link>
        . I confirm I am at least 16 years old.
      </span>
    </div>
  );
}

export function ConsentForm({
  agreed,
  pending,
  onAgreedChange,
  onSubmit,
}: {
  agreed: boolean;
  pending: boolean;
  onAgreedChange(agreed: boolean): void;
  onSubmit(): void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!agreed || pending) return;
        onSubmit();
      }}
    >
      <ConsentAgreement agreed={agreed} onAgreedChange={onAgreedChange} />

      <div className="mt-4 flex justify-end">
        <Button type="submit" disabled={!agreed || pending} className="shadow-stamp">
          {pending ? "Saving…" : "Agree and continue"}
        </Button>
      </div>
    </form>
  );
}

export function TermsGate() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyProfile);
  const acceptFn = useServerFn(acceptTerms);
  const { data, isLoading } = useQuery({ queryKey: ["my-profile"], queryFn: () => getFn() });
  const [agreed, setAgreed] = useState(false);

  const accept = useMutation({
    mutationFn: () => acceptFn(),
    onSuccess: () => {
      toast.success("Thanks — welcome to Scenik.");
      qc.invalidateQueries({ queryKey: ["my-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return null;
  if (data.terms_accepted_at) return null;

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-lg"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Logo className="h-7 w-7 text-primary" />
          </div>
          <DialogTitle className="text-center font-serif text-xl">
            Before you start driving
          </DialogTitle>
          <DialogDescription className="text-center">
            Please review and agree to our Terms &amp; Conditions and Privacy Notice to continue
            using Scenik.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-ink/85">
          <p>
            Scenik provides automated scenic-route suggestions. You are responsible for driving
            safely and obeying traffic laws. Your account, route, and, during navigation, location
            data are processed as described in the Privacy Notice.
          </p>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <Link to="/terms" target="_blank" rel="noreferrer" className="text-primary underline">
              Read Terms &amp; Conditions
            </Link>
            <Link to="/privacy" target="_blank" rel="noreferrer" className="text-primary underline">
              Read Privacy Notice
            </Link>
          </div>
        </div>

        <ConsentForm
          agreed={agreed}
          pending={accept.isPending}
          onAgreedChange={setAgreed}
          onSubmit={() => accept.mutate()}
        />
      </DialogContent>
    </Dialog>
  );
}
