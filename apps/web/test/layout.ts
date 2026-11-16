import { type BrowserContext, expect, type Page } from "@playwright/test";

/** Options of the journey's Playwright projects. */
export interface LayoutOptions {
  /** Every letter set wider than on any font this machine has: see `widenText`. */
  widerText: boolean;
}

/**
 * Wider by 0.08em per letter: more than the difference between the narrow fonts on a developer's
 * machine and the wider ones on CI's runners (where the payment page once came out 5px too wide).
 * Appended to each stylesheet as it loads, so the Content-Security-Policy, which refuses inline
 * styles, stays as it is.
 */
const WIDER_TEXT = "\n*, ::before, ::after { letter-spacing: 0.08em !important; }\n";

export async function widenText(context: BrowserContext): Promise<void> {
  await context.route(/\.css(\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}${WIDER_TEXT}` });
  });
}

/**
 * Fails when anything on the page reaches past the right edge of the screen, and names it: the
 * innermost such elements, by tag, first classes, start of text and right edge. On a phone, a
 * page wider than the screen slides sideways and shifts every tap.
 *
 * An element counts when its box (`getBoundingClientRect().right`) or the text running out of it
 * (`scrollWidth`) ends past `document.documentElement.clientWidth`. Elements inside a box that
 * scrolls or clips (`overflow-x` other than `visible`) do not count: that box scrolls, not the
 * page, and it is checked itself.
 *
 * Often the element is not the cause: a grid track or flex row grew to fit something that
 * cannot shrink, and pushed it out. So each line also names the outermost container around it
 * that is wider than its own parent's content box: that parent's layout is the one to fix, for
 * example with `min-w-0` or a `minmax(0,1fr)` track (`grid-cols-1`).
 */
export async function expectNoSidewaysOverflow(page: Page, screen: string): Promise<void> {
  const report = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;

    const nameOf = (element: Element) => {
      const classes = [...element.classList].slice(0, 4).join(".");
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

      return `<${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}> "${text}"`;
    };

    const contentRight = (element: Element) => {
      const style = getComputedStyle(element);

      return (
        element.getBoundingClientRect().right -
        Number.parseFloat(style.paddingRight) -
        Number.parseFloat(style.borderRightWidth)
      );
    };

    const insideScroller = (element: Element) => {
      for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== "visible") return true;
      }

      return false;
    };

    const wide: { element: Element; right: number }[] = [];

    for (const element of document.body.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();

      if (box.width === 0 && box.height === 0) continue;

      const right =
        getComputedStyle(element).overflowX === "visible"
          ? Math.max(box.right, box.left + element.scrollWidth)
          : box.right;

      // One pixel of slack: `scrollWidth` is rounded to whole pixels.
      if (right > limit + 1 && !insideScroller(element)) wide.push({ element, right });
    }

    // A container that reaches past the edge usually does so because of what is inside it.
    const innermost = wide.filter(
      ({ element }) =>
        !wide.some((other) => other.element !== element && element.contains(other.element)),
    );

    return {
      limit,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: innermost.map(({ element, right }) => {
        let widened: string | null = null;
        let up: Element = element;

        while (up.parentElement && up.parentElement !== document.body) {
          const parent = up.parentElement;
          const edge = contentRight(parent);

          if (up.getBoundingClientRect().right > edge + 1) {
            widened = `${nameOf(up)} ends past the content edge of ${nameOf(parent)} at ${edge.toFixed(1)}px`;
          }

          up = parent;
        }

        return `${nameOf(element)} ends at ${right.toFixed(1)}px${widened ? `; ${widened}` : ""}`;
      }),
    };
  });

  expect(
    report.offenders,
    `${screen}: elements past the right edge of a ${report.limit}px wide screen`,
  ).toEqual([]);
  expect(
    report.scrollWidth,
    `${screen}: the page is wider than the ${report.limit}px wide screen`,
  ).toBeLessThanOrEqual(report.limit);
}
