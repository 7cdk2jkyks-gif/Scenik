import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/refund")({
  head: () => ({
    meta: [
      { title: "Subscription & Refund Terms — Scenik" },
      { name: "description", content: "Scenik's subscription terms, pricing disclosures, auto-renewal, cancellation, and 30-day money-back guarantee across web, iOS, and Android." },
      { property: "og:title", content: "Subscription & Refund Terms — Scenik" },
      { property: "og:description", content: "Scenik's subscription terms, pricing, auto-renewal, cancellation, and refund process for web, iOS, and Android." },
    ],
  }),
  component: RefundPage,
});

function RefundPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6 sm:py-6">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>
      </header>
      <article className="prose prose-neutral mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-serif text-3xl font-semibold text-ink sm:text-4xl">Subscription & Refund Terms</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>

        <section className="mt-8 space-y-6 text-ink/85 leading-relaxed">
          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">1. What Scenik Premium includes</h2>
            <p>Scenik offers a free tier and a paid "Premium" subscription. Premium unlocks additional features, currently including unlimited scenic route generation (the free tier is limited to 3 routes per rolling 7-day period), offline route data for saved routes, priority AI processing, and other premium features we may add or remove from time to time. The exact feature list at the time of your purchase is shown on the in-app pricing page.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">2. Plans, pricing, and billing period</h2>
            <p>Premium is offered on two billing periods. Prices shown in-app are the authoritative prices and may include or exclude VAT/sales tax depending on your jurisdiction and platform.</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Monthly plan:</strong> £4.99 per month, billed every month.</li>
              <li><strong>Annual plan:</strong> £49.99 per year, billed every 12 months (equivalent to approximately 2 months free compared with the monthly plan).</li>
            </ul>
            <p>Prices may differ by region, currency, or platform. On iOS and Android, prices are shown in your store's local currency and are set by Apple/Google price tiers. All prices are inclusive of any tax that Paddle, Apple, or Google is required to collect. We may change prices in the future; existing subscribers will be notified of any change before it takes effect and may cancel before the new price applies.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">3. Automatic renewal</h2>
            <p><strong>All Scenik subscriptions renew automatically</strong> at the end of each billing period at the then-current price, until you cancel. You authorise Paddle, Apple, or Google (as applicable) to charge your saved payment method on each renewal. No prior notice is given before renewal charges beyond what the applicable store or Paddle sends by default.</p>
            <p>To avoid being charged for the next period, cancel <strong>at least 24 hours before the current period ends</strong> on iOS/Android (Apple/Google requirement) or before the renewal date on web.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">4. Cancellation</h2>
            <p>You can cancel any time. Cancellation stops future renewals; you keep Premium access until the end of the current paid period. No partial-period refunds are given on cancellation (except as required by law or under the money-back guarantee in section 6).</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Web (goscenik.com):</strong> Settings → Manage subscription, or via <a className="text-primary underline" href="https://paddle.net" target="_blank" rel="noreferrer">paddle.net</a>.</li>
              <li><strong>iOS:</strong> iPhone/iPad → Settings → [your name] → Subscriptions → Scenik → Cancel Subscription.</li>
              <li><strong>Android:</strong> Google Play app → Profile → Payments & subscriptions → Subscriptions → Scenik → Cancel subscription.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">5. Upgrades, downgrades, and plan changes</h2>
            <p><strong>Web:</strong> If you upgrade from Monthly to Annual, Paddle typically pro-rates the change and charges the difference for the remainder of the current period. If you downgrade from Annual to Monthly, the change takes effect at the end of the current Annual period; no partial refund is issued.</p>
            <p><strong>iOS and Android:</strong> Plan changes are handled by Apple or Google respectively, following their upgrade/downgrade policies (Apple pro-rates upgrades immediately and queues downgrades for the next period; Google's behaviour is similar).</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">6. 30-day money-back guarantee (web)</h2>
            <p>For subscriptions purchased on the web through Paddle, we offer a <strong>30-day money-back guarantee</strong>. If you are not satisfied, you may request a full refund of your most recent payment within 30 days of the order date, no questions asked. Approved refunds are returned to your original payment method within 5–10 business days, depending on your bank.</p>
            <p>The money-back guarantee is offered voluntarily and does not affect any statutory rights you may have as a consumer.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">7. Refunds on iOS and Android</h2>
            <p><strong>Refunds for iOS purchases are handled by Apple</strong>, not by us. Request a refund at <a className="text-primary underline" href="https://reportaproblem.apple.com" target="_blank" rel="noreferrer">reportaproblem.apple.com</a>. Apple's decision on iOS refunds is final and we cannot override it.</p>
            <p><strong>Refunds for Android purchases are handled by Google</strong>. Request a refund at <a className="text-primary underline" href="https://play.google.com/store/account/subscriptions" target="_blank" rel="noreferrer">play.google.com/store/account/subscriptions</a> or via Google Play support. Google's decision on Play refunds is final.</p>
            <p>We are happy to assist by revoking or restoring entitlements on our side once a store refund has been issued.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">8. How to request a refund on the web</h2>
            <p>Refunds for web purchases are processed by our payment provider, Paddle, which is the Merchant of Record for all Scenik web orders. To request a refund:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Visit <a className="text-primary underline" href="https://paddle.net" target="_blank" rel="noreferrer">paddle.net</a> and look up your order using the email you paid with, or</li>
              <li>Contact our support team in-app and we will help route the request to Paddle.</li>
            </ul>
            <p>Please include your order/transaction ID and the email used at checkout to speed things up.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">9. Free trials and promotional offers</h2>
            <p>From time to time we may offer free trials, discounted introductory periods, or promotional pricing. Unless stated otherwise: (a) at the end of a free trial or introductory period, your subscription will automatically renew at the standard price for the plan you chose; (b) promotional pricing applies only to the specified initial term and cannot be combined with other offers; (c) if you are eligible for a free trial, you can cancel any time before the trial ends to avoid being charged.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">10. Taxes</h2>
            <p>Prices displayed in-app and at checkout include any VAT, GST, or sales tax that Paddle, Apple, or Google is legally required to collect for your location. Because Paddle, Apple, and Google act as Merchant of Record, they are responsible for collecting and remitting these taxes.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">11. Failed payments</h2>
            <p>If a renewal payment fails, Paddle, Apple, or Google will retry according to their standard dunning rules. Your Premium access may be paused after a period of unpaid balance. If payment cannot be recovered, the subscription will be cancelled and Premium features will be locked. You can resubscribe at any time.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">12. No hidden charges</h2>
            <p>Scenik does not add any charges beyond the advertised subscription price. There are no setup fees, in-app microtransactions, per-route fees, ad-removal fees, or hidden charges. The only amounts you will be charged are the subscription price shown at checkout and any tax the processor is required to collect.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">13. Consumer withdrawal rights (UK/EU/EEA)</h2>
            <p>If you are a consumer in the UK, EU or EEA, you normally have 14 days from purchase to withdraw from a digital service contract without giving a reason. By starting to use Premium during that 14-day period, you expressly consent to immediate performance and acknowledge that you lose the statutory right of withdrawal once the service has begun. This does not affect the voluntary 30-day money-back guarantee in section 6, nor any mandatory statutory rights that cannot be waived.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">14. Restoring purchases</h2>
            <p>If you re-install the app or sign in on a new device, use Settings → Restore Purchases to re-sync your entitlement from Apple, Google, or Paddle. Entitlements are attached to the store account used at purchase; you may need to sign in with the same Apple ID, Google account, or Scenik email you used originally.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">15. Chargebacks</h2>
            <p>Initiating a chargeback with your bank without first attempting a refund through Paddle, Apple, or Google may result in immediate suspension of your account while the dispute is investigated, and we may recover reasonable dispute fees where permitted by law. We would much rather resolve issues directly — please contact us first.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">16. Contact</h2>
            <p>For any subscription or refund questions, contact us via the in-app support channel. For payment-processor-specific issues, contact <a className="text-primary underline" href="https://paddle.net" target="_blank" rel="noreferrer">Paddle</a> (web), <a className="text-primary underline" href="https://support.apple.com" target="_blank" rel="noreferrer">Apple Support</a> (iOS), or <a className="text-primary underline" href="https://support.google.com/googleplay" target="_blank" rel="noreferrer">Google Play Support</a> (Android).</p>
          </div>
        </section>

        <div className="mt-10 flex flex-wrap gap-4">
          <Link to="/terms" className="text-primary underline">Terms & Conditions</Link>
          <Link to="/privacy" className="text-primary underline">Privacy Notice</Link>
          <Link to="/pricing" className="text-primary underline">Pricing</Link>
        </div>
      </article>
    </div>
  );
}
