import { describe, expect, it } from "vitest";
import { DEFAULT_LANDING, safeReturnPath, signInHref } from "../src/lib/return-path.ts";

const APPROVAL = "/w/ws_01HZY/approvals/apr_01HZY";

describe("safeReturnPath", () => {
  it.each([
    APPROVAL,
    "/w/ws_01HZY/approvals",
    "/settings",
    "/w/ws_01HZY/activity?cursor=40",
    "/w/ws_01HZY/wallets/wal_01HZY#agents",
  ])("keeps the app path %s", (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it("resolves dot segments, so the checked path is the opened path", () => {
    expect(safeReturnPath("/w/ws_01HZY/../../settings")).toBe("/settings");
  });

  it.each([
    "//evil.example",
    "//evil.example/w/ws_01HZY",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/w/ws_01HZY\\..\\..\\evil",
    "https://evil.example/",
    "http:/evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.example",
    "w/ws_01HZY/approvals",
    "./settings",
    "/\t/evil.example",
    "/\n/evil.example",
    "\t//evil.example",
    "/settings\u0000",
    "/settings\u007f",
    "/.//evil.example",
    "/x/..//evil.example",
    "",
    `/${"a".repeat(2048)}`,
  ])("falls back to the landing page for %j", (hostile) => {
    expect(safeReturnPath(hostile)).toBe(DEFAULT_LANDING);
  });

  it.each([undefined, null, 42, ["/settings"], { next: "/settings" }])(
    "falls back to the landing page for a non-string %j",
    (value) => {
      expect(safeReturnPath(value)).toBe(DEFAULT_LANDING);
    },
  );
});

describe("signInHref", () => {
  it("carries a safe page to the sign-in page and back out unchanged", () => {
    const href = signInHref(`${APPROVAL}?tab=details`);
    const url = new URL(href, "https://os.example");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe(`${APPROVAL}?tab=details`);
  });

  it("asks for no page when the request was the landing page or unsafe", () => {
    expect(signInHref("/")).toBe("/login");
    expect(signInHref("//evil.example")).toBe("/login");
  });
});
