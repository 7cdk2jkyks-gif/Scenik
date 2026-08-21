import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedRouteDeleteButton } from "./_authenticated/routes";

describe("saved route deletion control", () => {
  it("renders one icon-only 44px delete action with an accessible name", () => {
    const control = SavedRouteDeleteButton({
      disabled: false,
      pending: false,
      onDelete: () => undefined,
      confirmDelete: () => true,
    });
    const html = renderToStaticMarkup(control);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.match(html, /aria-label="Delete route"/);
    assert.match(html, /h-11 w-11/);
    assert.doesNotMatch(html, />\s*Delete\s*</);
  });

  it("contains bubbling, honours cancellation and blocks pending repeats", () => {
    let deletes = 0;
    let prevented = 0;
    let stopped = 0;
    const event = {
      preventDefault: () => (prevented += 1),
      stopPropagation: () => (stopped += 1),
    };
    SavedRouteDeleteButton({
      disabled: false,
      pending: false,
      onDelete: () => (deletes += 1),
      confirmDelete: () => false,
    }).props.onClick(event);
    assert.deepEqual({ deletes, prevented, stopped }, { deletes: 0, prevented: 1, stopped: 1 });

    SavedRouteDeleteButton({
      disabled: false,
      pending: false,
      onDelete: () => (deletes += 1),
      confirmDelete: () => true,
    }).props.onClick(event);
    assert.equal(deletes, 1);

    SavedRouteDeleteButton({
      disabled: false,
      pending: true,
      onDelete: () => (deletes += 1),
      confirmDelete: () => true,
    }).props.onClick(event);
    assert.equal(deletes, 1);
  });
});
