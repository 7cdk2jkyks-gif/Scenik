import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentAgreement, ConsentForm } from "./TermsGate";

type ElementProps = {
  children?: unknown;
  className?: string;
  onCheckedChange?(value: boolean): void;
};

function agreementParts(agreed: boolean, onAgreedChange: (agreed: boolean) => void = () => {}) {
  const agreement = ConsentAgreement({ agreed, onAgreedChange });
  const children = Children.toArray(agreement.props.children).filter(
    isValidElement,
  ) as ReactElement<ElementProps>[];
  const touchLabel = children[0];
  const text = children[1];
  const checkbox = touchLabel.props.children as ReactElement<ElementProps>;
  const legalLinks = Children.toArray(text.props.children as ReactNode).filter(
    (child): child is ReactElement<{ to: string }> => isValidElement(child),
  );
  return { agreement, touchLabel, checkbox, legalLinks };
}

describe("consent agreement", () => {
  it("renders a required circular checkbox with a 44px touch target and accessible name", () => {
    const { touchLabel, checkbox } = agreementParts(false);
    const html = renderToStaticMarkup(checkbox);
    assert.match(html, /role="checkbox"/);
    assert.match(html, /aria-labelledby="agree-label"/);
    assert.match(html, /aria-required="true"/);
    assert.match(touchLabel.props.className ?? "", /h-11 w-11/);
    assert.match(html, /h-\[26px\] w-\[26px\] rounded-full/);
  });

  it("preserves checked state and independent legal links", () => {
    const { checkbox, legalLinks } = agreementParts(true);
    const html = renderToStaticMarkup(checkbox);
    assert.match(html, /data-state="checked"/);
    assert.deepEqual(
      legalLinks.map((link) => link.props.to),
      ["/terms", "/privacy"],
    );
  });

  it("propagates accessible checkbox state changes used by pointer and keyboard activation", () => {
    const changes: boolean[] = [];
    const { checkbox } = agreementParts(false, (agreed) => changes.push(agreed));
    checkbox.props.onCheckedChange?.(true);
    checkbox.props.onCheckedChange?.(false);
    assert.deepEqual(changes, [true, false]);
  });

  it("uses the Production form path and blocks absent consent and pending duplicate submission", () => {
    let submissions = 0;
    const event = { preventDefault() {} };
    const blocked = ConsentForm({
      agreed: false,
      pending: false,
      onAgreedChange: () => undefined,
      onSubmit: () => (submissions += 1),
    });
    blocked.props.onSubmit(event);
    assert.equal(submissions, 0);

    const accepted = ConsentForm({
      agreed: true,
      pending: false,
      onAgreedChange: () => undefined,
      onSubmit: () => (submissions += 1),
    });
    accepted.props.onSubmit(event);
    assert.equal(submissions, 1);

    const pending = ConsentForm({
      agreed: true,
      pending: true,
      onAgreedChange: () => undefined,
      onSubmit: () => (submissions += 1),
    });
    pending.props.onSubmit(event);
    assert.equal(submissions, 1);
  });
});
