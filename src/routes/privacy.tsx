import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Notice — Scenik" },
      { name: "description", content: "How Scenik collects, uses, shares, and protects your personal information, and the rights you have." },
      { property: "og:title", content: "Privacy Notice — Scenik" },
      { property: "og:description", content: "How Scenik collects, uses, shares, and protects your personal information, and the rights you have." },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6 sm:py-6">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>
      </header>
      <article className="prose prose-neutral mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-serif text-3xl font-semibold text-ink sm:text-4xl">Privacy Notice</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>

        <section className="mt-8 space-y-6 text-ink/85 leading-relaxed">
          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">1. Introduction and controller</h2>
            <p>This Privacy Notice explains how Scenik ("we", "us", "our"), the operator of the Scenik website at goscenik.com and the Scenik mobile apps on iOS and Android (the "Service"), collects, uses, discloses, and protects personal data about you. Scenik is the data controller for the personal data described in this notice. This notice reflects our obligations under the UK GDPR, the EU GDPR, the California Consumer Privacy Act (CCPA/CPRA), and similar privacy laws.</p>
            <p>If you do not agree with this notice, please do not use the Service.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">2. Summary at a glance</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>We collect account, route, device, and (during navigation only) location data to run the Service.</li>
              <li>We do <strong>not</strong> sell your personal data and do not use advertising cookies or targeted advertising.</li>
              <li>Precise GPS location is only used <strong>during active navigation</strong> and is not stored as a location history.</li>
              <li>Payments are handled by Paddle (web), Apple (iOS), or Google (Android). We never see or store your full card number.</li>
              <li>You can access, correct, export, or delete your data, or delete your entire account, from Settings at any time.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">3. Data we collect</h2>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.1 Account information</h3>
            <p>When you create an account we collect: your email address, display name (optional), bio (optional), avatar image (optional), unit and language preferences, authentication provider identifiers (Google or Apple sub ID) where you sign in with a social provider, the timestamp of your account creation, the timestamp at which you accepted our Terms, and (for anonymous/guest accounts) a device-generated identifier. We use this data to identify you, secure your account, personalise your experience, and enforce our Terms.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.2 Route data</h3>
            <p>When you plan or save routes we collect: origin and destination addresses (as text and as geocoded latitude/longitude), waypoints, mood and theme selections, generated route data (polylines, distance, duration, scenic score), route titles you set, the visibility state (private or public), saved-route metadata, comments and ratings you leave on other users' public routes, likes, and road reports you submit. If you make a route public, the route title, polyline, origin/destination area, and comments become visible to other users of the Service.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.3 Location tracking (navigation only)</h3>
            <p>We access your device's precise GPS position <strong>only while turn-by-turn navigation is active in the foreground</strong>. Location data is processed transiently, in-session, to compute directions, snap you to the route, estimate your speed and ETA, and trigger voice guidance. Precise location fixes are <strong>not written to our database</strong> and are <strong>not built into a location history</strong> that we can browse or share. Location access requires an OS-level permission that you grant and can revoke at any time in your device settings. If you deny location access, turn-by-turn navigation will not function, but the rest of the app remains usable.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.4 Payment processing</h3>
            <p>We store subscription state (plan identifier, status, current period end, cancellation flag, environment such as test/live), the payment processor's customer and subscription identifiers, and the timestamp of purchase events. We do <strong>not</strong> collect or store full card numbers, CVCs, or any payment instrument details. Card processing is performed entirely by Paddle (on the web), Apple (in the iOS app), or Google (in the Android app). See section 6 for their roles.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.5 Product analytics (opt-in)</h3>
            <p>If you consent, we use PostHog to collect product analytics: page views, feature usage, funnel events (e.g. sign-up completed, route generated, subscription started), errors, and coarse device/browser information. Analytics events are associated with an internal user identifier where you are signed in, or an anonymous device identifier otherwise. You can withdraw consent at any time from Settings → Privacy, which stops future analytics collection on this device. We do not use analytics for advertising or profiling.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.6 Technical and diagnostic data</h3>
            <p>We collect data required to operate a modern web/mobile service securely: IP address (used transiently for request routing, rate limiting, abuse prevention, and coarse locale detection), browser and OS user-agent, device type and model, app version, network type, screen size, timezone, referrer for web requests, error stack traces, and crash reports. We use this data for security, fraud prevention, debugging, and improving reliability.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.7 Support communications</h3>
            <p>If you contact us for support, we process the content of your messages, your contact details, and any information you choose to share, in order to respond and keep a record of the issue.</p>

            <h3 className="font-serif text-xl font-semibold text-ink mt-4">3.8 Data we do not collect</h3>
            <p>We do not collect biometric data, health data, contact lists, calendar entries, photos other than the avatar you choose to upload, microphone audio, or advertising identifiers.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">4. How we use your data (purposes)</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Provide the Service:</strong> create and manage your account, authenticate you, generate scenic routes, provide navigation and voice guidance, save your routes, and enable community features.</li>
              <li><strong>Personalise:</strong> remember your preferences (units, language, saved locations, consent choices).</li>
              <li><strong>Payments and subscriptions:</strong> confirm entitlements, apply the correct plan, and reconcile with the payment processor.</li>
              <li><strong>Communicate:</strong> respond to support, send essential transactional notices (e.g. account changes, billing, security alerts).</li>
              <li><strong>Improve:</strong> understand feature usage in aggregate, diagnose errors, and prioritise improvements.</li>
              <li><strong>Security and fraud prevention:</strong> detect abuse, rate-limit requests, prevent unauthorised access, and investigate suspicious activity.</li>
              <li><strong>Comply with law:</strong> respond to lawful requests, meet tax, accounting, and record-keeping obligations, and enforce our Terms.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">5. Legal bases (UK/EU GDPR)</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Performance of a contract:</strong> account creation, delivering routes, navigation, payments, and support.</li>
              <li><strong>Legitimate interests:</strong> security, fraud prevention, service reliability, service improvement, and defending legal claims — balanced against your rights and freedoms.</li>
              <li><strong>Consent:</strong> optional product analytics and any non-essential cookies. You may withdraw consent at any time without affecting past processing.</li>
              <li><strong>Legal obligation:</strong> tax records, responding to lawful requests, and meeting statutory retention duties.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">6. Sharing and processors</h2>
            <p>We share personal data only with providers that help us run the Service, under written contracts that require appropriate security and confidentiality. We do not sell your personal data and do not share it for cross-context behavioural advertising.</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Hosting, database, authentication, and storage:</strong> our managed cloud infrastructure provider (acting as processor).</li>
              <li><strong>Maps, directions, geocoding, places autocomplete:</strong> Google Maps Platform.</li>
              <li><strong>AI features (route themes, waypoint facts, guidance copy):</strong> our AI model gateway and underlying model providers. Prompts sent to these providers may include the route's origin/destination area, mood, and theme; they do not include your name, email, or precise real-time location.</li>
              <li><strong>Payments (web):</strong> Paddle, acting as Merchant of Record for web subscriptions.</li>
              <li><strong>Payments (iOS):</strong> Apple, via App Store and StoreKit.</li>
              <li><strong>Payments (Android):</strong> Google, via Google Play Billing.</li>
              <li><strong>Subscription management (mobile):</strong> RevenueCat, which receives store receipts to determine your entitlement.</li>
              <li><strong>Product analytics (opt-in):</strong> PostHog.</li>
              <li><strong>Authorities and legal:</strong> we may disclose data where required by law, to comply with legal process, to enforce our Terms, or to protect rights, property, or safety.</li>
              <li><strong>Corporate transactions:</strong> in a merger, acquisition, or asset sale, personal data may be transferred subject to this notice or an equivalent one.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">7. International transfers</h2>
            <p>Some processors are located outside the UK/EEA (including the United States). Where personal data is transferred outside your jurisdiction, we rely on lawful transfer mechanisms such as the UK International Data Transfer Agreement, the EU Standard Contractual Clauses, and applicable adequacy decisions. You may request more information about our transfer safeguards using the contact details below.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">8. Retention</h2>
            <p>We keep personal data only as long as necessary for the purposes described:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Account and profile:</strong> for as long as your account is active.</li>
              <li><strong>Routes, ratings, comments:</strong> until you delete them or your account.</li>
              <li><strong>Location fixes during navigation:</strong> processed transiently in-session and not stored.</li>
              <li><strong>Support messages:</strong> up to 24 months after your query is resolved.</li>
              <li><strong>Payment and tax records:</strong> retained by us and/or Paddle/Apple/Google for the period required by applicable tax and accounting law (typically 6–10 years).</li>
              <li><strong>Security and abuse logs:</strong> up to 12 months.</li>
              <li><strong>Analytics events (if you consented):</strong> up to 24 months, then aggregated or deleted.</li>
            </ul>
            <p>When you delete your account, we delete or irreversibly anonymise your personal data within 30 days, except where retention is required by law (for example, tax records) or where content has already been shared publicly (for example, comments on other users' public routes, which may be retained in an anonymised form).</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">9. Your rights</h2>
            <p>Subject to applicable law, you have the right to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>request access to the personal data we hold about you;</li>
              <li>request correction of inaccurate or incomplete data;</li>
              <li>request deletion of your data ("right to be forgotten");</li>
              <li>request restriction or object to certain processing;</li>
              <li>request portability of the data you have provided to us;</li>
              <li>withdraw consent at any time, without affecting past processing;</li>
              <li>lodge a complaint with your local data protection authority — in the UK, the Information Commissioner's Office (ico.org.uk); in the EU/EEA, your national supervisory authority.</li>
            </ul>
            <p>You can exercise most of these rights directly in Settings (edit profile, export data, delete account). Otherwise, contact us using the details below and we will respond within one month (extendable by two months for complex requests).</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">10. California residents (CCPA/CPRA)</h2>
            <p>If you are a California resident, you have the right to know what personal information we collect, to request deletion or correction, to opt out of any "sale" or "sharing" (we do neither), and to be free from discrimination for exercising these rights. We disclose the categories of personal information we collect and our purposes in sections 3 and 4. To exercise your rights, use Settings or contact us.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">11. Cookies and local storage</h2>
            <p>We use only strictly-necessary cookies and local storage: authentication tokens, session state, remembered preferences (units, language, consent choices), and remembered location-permission acknowledgement. We do not use advertising, targeting, or cross-site tracking cookies. If you opt in to analytics, PostHog stores a first-party identifier locally to deduplicate events.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">12. Children</h2>
            <p>Scenik is not directed at children under 16 and we do not knowingly collect their personal data. If you believe a child under 16 has provided us data, please contact us and we will delete it.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">13. Security</h2>
            <p>We use industry-standard measures to protect your data, including encryption in transit (HTTPS/TLS), encryption at rest for databases, least-privilege database access via row-level security policies, hashed and salted password storage (handled by our authentication provider), audit logging, and access controls on our infrastructure. No system is perfectly secure; please use a strong, unique password, enable OS-level device protection, and notify us immediately if you suspect unauthorised access to your account.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">14. Automated decision-making and AI</h2>
            <p>Route suggestions, scenic scores, waypoint facts, and voice guidance are generated using AI models. These are informational suggestions, not decisions with legal or similarly significant effect on you within the meaning of Article 22 UK/EU GDPR. AI outputs may be inaccurate; you must independently verify anything that matters.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">15. Third-party links</h2>
            <p>The Service may link to third-party websites (for example, Paddle's checkout, map data attributions, or provider policies). Those sites have their own privacy notices; we are not responsible for their practices.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">16. Changes to this notice</h2>
            <p>We may update this notice from time to time. Material changes will be highlighted in-app and the "Last updated" date above will change. Continued use after the effective date constitutes acknowledgement of the updated notice.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">17. Contact</h2>
            <p>Questions about this notice, or to exercise any of your privacy rights, contact us via the in-app support channel or through the contact details published on goscenik.com. Please include enough information for us to verify your identity and locate your account.</p>
          </div>
        </section>

        <div className="mt-10 flex flex-wrap gap-4">
          <Link to="/terms" className="text-primary underline">Terms & Conditions</Link>
          <Link to="/refund" className="text-primary underline">Subscription & Refund Terms</Link>
          <Link to="/delete-account" className="text-primary underline">Delete my account</Link>
          <Link to="/auth" className="text-primary underline">Back to sign in</Link>
        </div>
      </article>
    </div>
  );
}
