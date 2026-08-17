import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommunityFeedFooter,
  CommunityLikeButton,
  CommunitySortControls,
  type CommunitySort,
} from "@/components/CommunityControls";

type ClickableProps = { onClick: () => void; children?: unknown };

const clickableChildren = (element: ReactElement) =>
  Children.toArray(element.props.children).filter(isValidElement) as ReactElement<ClickableProps>[];

describe("Community rendered controls", () => {
  it("renders an accessible, comment-free mobile-safe feed footer", () => {
    let toggles = 0;
    const historicalRoute = {
      title: "Fictional Moorland Drive",
      likeCount: 12,
      comment_count: 48,
    };
    const footer = CommunityFeedFooter({
      creator: <span>by Rowan</span>,
      title: historicalRoute.title,
      likeCount: historicalRoute.likeCount,
      isLiked: false,
      onToggleLike: () => {
        toggles += 1;
      },
    });
    const html = renderToStaticMarkup(footer);

    assert.match(html, /by Rowan/);
    assert.match(html, />12<\/button>/);
    assert.match(html, /aria-label="Like Fictional Moorland Drive"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /justify-between gap-3/);
    assert.doesNotMatch(html, /comment|MessageCircle/i);

    const likeButton = clickableChildren(footer).find(
      (child) => child.type === CommunityLikeButton,
    );
    assert.ok(likeButton);
    (likeButton.props as Parameters<typeof CommunityLikeButton>[0]).onToggle();
    assert.equal(toggles, 1);
  });

  it("renders and invokes both detail like states with pressed semantics", () => {
    let toggles = 0;
    const render = (isLiked: boolean) =>
      CommunityLikeButton({
        title: "Fictional Coastal Loop",
        count: 7,
        isLiked,
        onToggle: () => {
          toggles += 1;
        },
        variant: "detail",
      });

    const unliked = render(false);
    assert.match(renderToStaticMarkup(unliked), /aria-label="Like Fictional Coastal Loop"/);
    assert.match(renderToStaticMarkup(unliked), /aria-pressed="false"/);
    unliked.props.onClick();

    const liked = render(true);
    const likedHtml = renderToStaticMarkup(liked);
    assert.match(likedHtml, /aria-label="Unlike Fictional Coastal Loop"/);
    assert.match(likedHtml, /aria-pressed="true"/);
    assert.match(likedHtml, />7<\/button>/);
    assert.doesNotMatch(likedHtml, /comment|composer|conversation/i);
    liked.props.onClick();

    assert.equal(toggles, 2);
  });

  it("renders all sorting choices and invokes the selected production value", () => {
    const selected: CommunitySort[] = [];
    const controls = CommunitySortControls({
      value: "new",
      onChange: (sort) => selected.push(sort),
    });
    const html = renderToStaticMarkup(controls);

    assert.match(html, />New<\/button>/);
    assert.match(html, />Most loved<\/button>/);
    assert.match(html, />Top rated<\/button>/);
    assert.match(html, /aria-pressed="true"/);

    const buttons = clickableChildren(controls);
    buttons[1]?.props.onClick();
    buttons[2]?.props.onClick();
    assert.deepEqual(selected, ["top", "rated"]);
  });
});
