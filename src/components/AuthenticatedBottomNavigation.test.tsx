import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUTHENTICATED_PAGE_BOTTOM_PADDING,
  AuthenticatedBottomNavigation,
  CommunityBottomNavigation,
} from "./AuthenticatedBottomNavigation";

describe("authenticated Community navigation", () => {
  it("uses the standard fixed safe-area navigation and active Explore destination", () => {
    const navigation = AuthenticatedBottomNavigation();
    assert.equal(navigation.type, "nav");
    assert.equal(navigation.props["aria-label"], "Primary");
    assert.match(navigation.props.className, /fixed inset-x-0 bottom-0 z-40/);
    assert.match(AUTHENTICATED_PAGE_BOTTOM_PADDING, /safe-area-inset-bottom/);

    const links = Children.toArray(navigation.props.children.props.children).filter(
      isValidElement,
    ) as ReactElement<{ to: string; children: (state: { isActive: boolean }) => ReactElement }>[];
    const explore = links.find((link) => link.props.to === "/community");
    assert.ok(explore);
    const activeButton = explore.props.children({ isActive: true });
    const html = renderToStaticMarkup(activeButton);
    assert.match(html, /aria-current="page"/);
    assert.match(html, />Explore</);
  });

  it("renders once for authenticated list/detail flows and never for signed-out users", () => {
    assert.equal(CommunityBottomNavigation({ authenticated: false }), null);
    const authenticated = CommunityBottomNavigation({ authenticated: true });
    assert.ok(authenticated);
    assert.equal(authenticated.type, AuthenticatedBottomNavigation);
  });
});
