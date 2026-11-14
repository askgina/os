/**
 * The Content-Security-Policy the control plane sends with every response, and the one the UI's
 * development servers send too, so a page that needs an inline script, an inline `<style>` or an
 * outside request fails during development instead of in production.
 *
 * The UI is a bundle of our own scripts and styles. Nothing inline, nothing from elsewhere, no
 * framing: an injected script or a hostile page around the approval card is what this denies.
 * Inline `style` attributes stay allowed because the UI's popover components position
 * themselves with them; they cannot run code.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
