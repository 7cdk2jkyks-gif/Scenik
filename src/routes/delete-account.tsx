import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { Mail, Trash2, ShieldCheck } from "lucide-react";

// Public account-deletion page.
// Google Play (since 2024) and Apple both require a publicly-reachable URL
// where users can request account deletion *without* having to sign in.
// This page satisfies that requirement: it explains the in-app flow AND
// provides a fallback email contact for users who no longer have access
// to their account.
export const Route = createFileRoute("/delete-account")({
  head: () => ({
    meta: [
      { title: "Delete your Scenik account" },
      {
        name: "description",
        content:
          "Request deletion of your Scenik account and all associated data. Delete from Settings inside the app, or contact support.",
      },
      { name: "robots", content: "index, follow" },
    ],
  }),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const supportEmail = "support@scenik.app";
  const subject = encodeURIComponent("Delete my Scenik account");
  const body = encodeURIComponent(
    "Hi Scenik team,\n\nPlease permanently delete my Scenik account and all associated data.\n\nAccount email: <fill in the email you signed up with>\n\nThank you.",
  );

  return (
    <div className="min-h-screen bg-background px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto w-full max-w-2xl">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>

        <Card className="border-border bg-card p-6 shadow-paper sm:p-10">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="mt-4 text-center font-serif text-2xl font-semibold text-ink sm:text-3xl">
            Delete your account
          </h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            You can permanently delete your Scenik account and all associated
            data at any time.
          </p>

          <section className="mt-8 space-y-6 text-sm text-ink">
            <div>
              <h2 className="font-serif text-lg font-semibold">
                Option 1 — Delete inside the app (fastest)
              </h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Open Scenik and sign in.</li>
                <li>Go to <strong>Settings</strong>.</li>
                <li>
                  Scroll to <strong>Danger zone</strong> and tap
                  {" "}<strong>Delete account</strong>.
                </li>
                <li>Confirm. Your account and data are removed immediately.</li>
              </ol>
              <div className="mt-3">
                <Link to="/auth">
                  <Button variant="outline" size="sm">
                    Sign in to delete
                  </Button>
                </Link>
              </div>
            </div>

            <div className="border-t border-border pt-6">
              <h2 className="font-serif text-lg font-semibold">
                Option 2 — Email us
              </h2>
              <p className="mt-2 text-muted-foreground">
                If you can no longer sign in, email us from the address linked
                to your account. We reply within 7 days and complete deletion
                within 30 days of a verified request.
              </p>
              <div className="mt-3">
                <a href={`mailto:${supportEmail}?subject=${subject}&body=${body}`}>
                  <Button size="sm">
                    <Mail className="mr-2 h-4 w-4" /> Email {supportEmail}
                  </Button>
                </a>
              </div>
            </div>

            <div className="rounded-md border border-border bg-muted/40 p-4">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  <p className="font-medium">What gets deleted</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    <li>Your profile, display name and bio</li>
                    <li>Saved routes, ratings, likes and comments</li>
                    <li>Saved searches and route generation history</li>
                    <li>Road reports you submitted</li>
                    <li>Earned badges and subscription record</li>
                    <li>Your authentication account</li>
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Anonymised, aggregated analytics that cannot identify you
                    may be retained. Scenik does not store detailed location
                    history at any point.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <p className="mt-8 text-center text-xs text-muted-foreground">
            Questions?{" "}
            <a href={`mailto:${supportEmail}`} className="text-primary underline">
              {supportEmail}
            </a>
            {" · "}
            <Link to="/privacy" className="text-primary underline">
              Privacy Notice
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
