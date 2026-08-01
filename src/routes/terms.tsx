import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms & Conditions — Scenik" },
      { name: "description", content: "Terms of service and conditions for using Scenik, the AI-assisted scenic route planner." },
      { property: "og:title", content: "Terms & Conditions — Scenik" },
      { property: "og:description", content: "Terms of service and conditions for using Scenik, the AI-assisted scenic route planner." },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6 sm:py-6">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-6 w-6 text-primary" />
          <span className="font-serif text-xl font-semibold text-ink">Scenik</span>
        </Link>
      </header>
      <article className="prose prose-neutral mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-serif text-3xl font-semibold text-ink sm:text-4xl">Terms & Conditions</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>

        <section className="mt-8 space-y-6 text-ink/85 leading-relaxed">
          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">1. About these Terms</h2>
            <p>These Terms & Conditions ("Terms") form a legally binding agreement between you ("you", "your", "user") and Scenik ("we", "us", "our"), the operator of the Scenik website at goscenik.com and the Scenik mobile applications on iOS and Android (collectively, the "Service"). By creating an account, signing in, using guest mode, purchasing a subscription, or otherwise accessing the Service, you confirm that you have read, understood, and agree to be bound by these Terms and by our <Link to="/privacy" className="text-primary underline">Privacy Notice</Link> and <Link to="/refund" className="text-primary underline">Refund Policy</Link>. If you do not agree, you must stop using the Service.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">2. Eligibility and authority</h2>
            <p>You must be at least 16 years old to use Scenik. If you are using Scenik on behalf of an organisation, you represent and warrant that you have authority to bind that organisation to these Terms. You must hold a valid driving licence and comply with all applicable laws when driving or operating a vehicle. The Service is not intended for use by anyone barred from receiving it under the laws of their jurisdiction.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">3. The Service</h2>
            <p>Scenik is an AI-assisted scenic-route planner. It uses artificial intelligence models together with third-party mapping, routing, geocoding, and place data to suggest scenic driving routes, waypoints, themes, points of interest, road commentary, and voice guidance. The Service is provided for personal, non-commercial use only, unless we have agreed otherwise in writing.</p>
            <p><strong>Nature of AI output.</strong> Routes, waypoints, themes, scenic scores, and generated commentary are AI-generated suggestions based on statistical patterns and third-party data. They may be inaccurate, incomplete, out of date, offensive, biased, or otherwise unsuitable for a given user or context. You must use your own judgement before acting on any output, and must independently verify anything that matters (road conditions, opening hours, legality, safety, and factual claims). We do not guarantee that any route is passable, safe, legal to drive, appropriate for your vehicle, or of any particular scenic quality.</p>
            <p><strong>Availability.</strong> The Service is provided on an "as available" basis. We do not guarantee uninterrupted, timely, secure, or error-free operation. We may change, suspend, restrict, or discontinue any part of the Service (including features, content, or premium tiers) at any time, with or without notice.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">4. Safe driving and user responsibility</h2>
            <p><strong>You are solely responsible for driving safely and lawfully.</strong> You must obey all traffic laws, road signs, signals, and the instructions of law-enforcement and highway authorities in your jurisdiction. Do not interact with Scenik while driving; use voice guidance only, mount your device safely, and pull over before adjusting settings. Do not follow a suggested route if doing so would be unsafe, illegal, or inappropriate for your vehicle, driver skill, weather, or road conditions.</p>
            <p>To the fullest extent permitted by law, Scenik is not liable for any accident, injury, death, loss of life, damage to property, traffic penalty, delay, fuel cost, vehicle wear, missed appointment, or other loss arising from your use of suggested routes, navigation, voice guidance, or any other part of the Service.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">5. Accounts and guest mode</h2>
            <p>You may use Scenik as a registered user (with an email, Google, or Apple account) or, where offered, as a guest. You must provide accurate sign-up information and keep it up to date. You are responsible for keeping your credentials confidential and for all activity that occurs under your account. Notify us immediately if you suspect unauthorised access. We may refuse, suspend, or terminate accounts we believe are duplicative, fraudulent, in breach of these Terms, or otherwise abusive.</p>
            <p>Guest accounts may have limited features, may not be recoverable if you lose device access, and may be deleted after a period of inactivity.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">6. Acceptable use</h2>
            <p>You agree not to, and not to permit anyone else to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>use the Service in breach of any law or regulation, or to promote or facilitate illegal activity;</li>
              <li>use the Service to harass, threaten, defame, or infringe the rights of any person;</li>
              <li>upload, submit, or share content that is unlawful, hateful, obscene, harmful, misleading, or infringes intellectual property or privacy rights;</li>
              <li>attempt to reverse-engineer, decompile, disassemble, or otherwise derive the source code, models, prompts, or training data behind the Service, except to the extent this restriction is prohibited by law;</li>
              <li>probe, scan, scrape, crawl, index, or test the vulnerability of the Service or bypass rate limits or access controls;</li>
              <li>use bots, automation, headless browsers, or other means to access the Service other than the interfaces we provide;</li>
              <li>upload malware, viruses, or other harmful code, or interfere with the availability, integrity, or security of the Service;</li>
              <li>resell, sublicense, redistribute, or commercially exploit the Service or its outputs, except as expressly permitted;</li>
              <li>use the Service or its outputs to train competing AI models or route-planning services;</li>
              <li>impersonate any person or misrepresent your affiliation with any person or organisation.</li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">7. User content</h2>
            <p>"User Content" means any content you submit or share through the Service, including saved routes, comments, ratings, road reports, profile information, avatars, and messages. You retain ownership of your User Content. By submitting User Content, you grant us a worldwide, royalty-free, non-exclusive, sublicensable licence to host, store, reproduce, adapt, translate, publish, display, and distribute it as necessary to operate, provide, promote, and improve the Service (including displaying shared routes to other users). This licence ends when you delete the content or your account, except where retention is required by law or where the content has already been shared with other users who retain their copies.</p>
            <p>You are solely responsible for your User Content. You represent and warrant that you have all rights required to submit it, that it is accurate, and that it does not violate these Terms or any third-party right. We may remove, block, or refuse User Content at our discretion, without notice, if we believe it breaches these Terms, applicable law, or platform rules (including Apple App Store and Google Play policies).</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">8. Intellectual property</h2>
            <p>Scenik and all associated software, models, prompts, content, branding, logos, trademarks, and documentation are owned by us or our licensors and are protected by copyright, trademark, and other intellectual property laws. Subject to your compliance with these Terms, we grant you a limited, revocable, non-exclusive, non-transferable, non-sublicensable licence to use the Service within your plan, solely for personal, non-commercial use.</p>
            <p>All rights not expressly granted are reserved. You may not copy, modify, adapt, translate, publish, distribute, sell, or create derivative works from any part of the Service, except as permitted by law or with our prior written consent.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">9. Payments, subscriptions, and Merchant of Record</h2>
            <p><strong>Web purchases (goscenik.com).</strong> Our order process is conducted by our online reseller Paddle.com. <strong>Paddle.com is the Merchant of Record for all our web orders.</strong> Paddle provides all customer service inquiries relating to payments and handles returns. Payment, billing, tax, invoicing, cancellations, and refunds for web purchases are governed by Paddle's <a className="text-primary underline" href="https://www.paddle.com/legal/checkout-buyer-terms" target="_blank" rel="noreferrer">Buyer Terms</a>, Paddle's <a className="text-primary underline" href="https://www.paddle.com/legal/refund-policy" target="_blank" rel="noreferrer">Refund Policy</a>, and our <Link to="/refund" className="text-primary underline">Refund Policy</Link>.</p>
            <p><strong>iOS purchases (App Store).</strong> Purchases made in the iOS app are processed by Apple through your App Store account and are subject to Apple's <a className="text-primary underline" href="https://www.apple.com/legal/internet-services/itunes/" target="_blank" rel="noreferrer">Media Services Terms</a>. Payment, billing, and refunds for iOS purchases are handled by Apple.</p>
            <p><strong>Android purchases (Google Play).</strong> Purchases made in the Android app are processed by Google through your Google Play account and are subject to <a className="text-primary underline" href="https://play.google.com/intl/en_us/about/play-terms/" target="_blank" rel="noreferrer">Google Play Terms of Service</a>. Payment, billing, and refunds for Android purchases are handled by Google.</p>
            <p>See our full <Link to="/refund" className="text-primary underline">Subscription & Refund Terms</Link> for detailed information on price, billing period, automatic renewal, cancellation, upgrades, downgrades, taxes, and how to obtain a refund on each platform.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">10. Free tier and usage limits</h2>
            <p>The free tier of Scenik has usage limits (for example, a limited number of route generations per rolling 7-day period). We may change these limits at any time. Attempts to circumvent limits (multiple accounts, automation, VPN farming) are a breach of these Terms and may result in suspension.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">11. Third-party services</h2>
            <p>The Service depends on third-party providers, including Google Maps Platform (maps, directions, geocoding, places), our cloud hosting and database providers, our AI model gateway, PostHog (analytics), Paddle (web payments), Apple (iOS payments, sign-in), Google (Android payments, sign-in), and RevenueCat (subscription management on mobile). Your use of features powered by these services is also subject to the applicable third-party terms. We are not responsible for third-party services, and their availability may change.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">12. Location data</h2>
            <p>Turn-by-turn navigation requires access to your device's precise location. You control this permission through your operating system. Location data is used only while navigation is active and is not stored as a history in our database. See the <Link to="/privacy" className="text-primary underline">Privacy Notice</Link> for full detail.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">13. Suspension and termination</h2>
            <p>We may suspend or terminate your access to the Service, in whole or in part, at any time and with or without notice, if we reasonably believe you have: (a) materially breached these Terms; (b) failed to pay amounts due; (c) created a security, fraud, chargeback, legal, or reputational risk; (d) repeatedly or seriously violated our policies or the policies of a platform we distribute through; or (e) used the Service in a way that could expose us or other users to harm.</p>
            <p>You may stop using and delete your account at any time through Settings or the Delete Account page. On termination, your right to use the Service ends immediately. Sections that by their nature should survive termination (including intellectual property, disclaimers, limitations of liability, indemnity, and dispute resolution) will survive.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">14. Disclaimers</h2>
            <p>To the maximum extent permitted by applicable law, the Service is provided "as is" and "as available", without warranties of any kind, whether express, implied, statutory, or otherwise. We specifically disclaim any implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement. We do not warrant that: (a) the Service will meet your requirements; (b) the Service will be uninterrupted, timely, secure, or error-free; (c) routes, waypoints, times, distances, or other outputs will be accurate, complete, safe, legal, or reliable; or (d) defects will be corrected.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">15. Limitation of liability</h2>
            <p>To the maximum extent permitted by applicable law, in no event will Scenik, its affiliates, officers, directors, employees, agents, licensors, or suppliers be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, revenue, data, goodwill, business opportunity, or other intangible losses, arising out of or relating to your use of, or inability to use, the Service, even if we have been advised of the possibility of such damages.</p>
            <p>Our aggregate liability arising out of or relating to these Terms or the Service will not exceed the greater of (a) the total amounts you paid to us (or through Paddle/Apple/Google on our behalf) in the 12 months immediately preceding the event giving rise to the claim, or (b) GBP £50.</p>
            <p><strong>Carve-outs.</strong> Nothing in these Terms excludes or limits liability that cannot be excluded or limited under applicable law, including liability for fraud, fraudulent misrepresentation, death or personal injury caused by negligence, or (where applicable) statutory consumer rights.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">16. Indemnity</h2>
            <p>To the maximum extent permitted by law, you agree to indemnify and hold harmless Scenik and its affiliates, officers, directors, employees, and agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising out of or in any way connected with: (a) your access to or use of the Service; (b) your User Content; (c) your breach of these Terms; or (d) your violation of any law or of any third-party right.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">17. Governing law and disputes</h2>
            <p>These Terms and any dispute or claim arising out of or in connection with them (including non-contractual disputes) are governed by the laws of England and Wales. Subject to mandatory consumer protections in your country of residence, you agree that the courts of England and Wales have exclusive jurisdiction to resolve any dispute. If you are a consumer resident in the EU/EEA or UK, you retain the benefit of any mandatory consumer protections in your country and may bring proceedings in your local courts where the law requires.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">18. Consumer rights (UK/EU/EEA)</h2>
            <p>Nothing in these Terms affects your statutory rights as a consumer that cannot be waived by contract. Where you purchase a digital subscription and expressly consent to immediate performance during any statutory cancellation period, you acknowledge that you may lose the right of withdrawal once the service has begun (this does not affect the money-back guarantee described in our <Link to="/refund" className="text-primary underline">Refund Policy</Link>).</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">19. Assignment</h2>
            <p>You may not assign or transfer these Terms, in whole or in part, without our prior written consent. We may assign these Terms in connection with a merger, acquisition, corporate reorganisation, or sale of all or substantially all of our assets, on notice to you.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">20. Force majeure</h2>
            <p>We are not liable for any failure or delay in performance caused by circumstances beyond our reasonable control, including acts of God, war, terrorism, riots, pandemics, government action, network or infrastructure failure, or failure of third-party providers.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">21. Changes to these Terms</h2>
            <p>We may update these Terms from time to time. If we make material changes we will notify you (for example, by in-app notice or by updating the "Last updated" date). Continued use of the Service after changes take effect constitutes acceptance of the revised Terms. If you do not agree to the changes, you must stop using the Service and may close your account.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">22. Entire agreement, severability, and waiver</h2>
            <p>These Terms, together with the <Link to="/privacy" className="text-primary underline">Privacy Notice</Link> and <Link to="/refund" className="text-primary underline">Refund Policy</Link>, constitute the entire agreement between you and us regarding the Service and supersede any prior agreements. If any provision is held to be invalid or unenforceable, the remaining provisions will remain in full force and effect. Our failure to enforce any right is not a waiver of that right.</p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink">23. Contact</h2>
            <p>Questions about these Terms? Contact us via the in-app support channel or through the contact details published on goscenik.com.</p>
          </div>
        </section>

        <div className="mt-10 flex flex-wrap gap-4">
          <Link to="/privacy" className="text-primary underline">Privacy Notice</Link>
          <Link to="/refund" className="text-primary underline">Subscription & Refund Terms</Link>
          <Link to="/auth" className="text-primary underline">Back to sign in</Link>
        </div>
      </article>
    </div>
  );
}
