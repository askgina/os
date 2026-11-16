import { ApiError, WorkspaceTemplate } from "@askgina/os-api";

/**
 * Taking a workspace elsewhere: its template (configuration, no secrets, no history) and its
 * record (the history, opened, that verifies offline), and reading a template file back in.
 */

/** A file name made of a workspace's name: letters and digits, the rest as single dashes. */
function fileStem(name: string): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

  return stem === "" ? "workspace" : stem;
}

/** "research-team-template.json". */
export function templateFileName(workspaceName: string): string {
  return `${fileStem(workspaceName)}-template.json`;
}

/** "research-team-record-2026-11-15.jsonl", dated in UTC. */
export function recordFileName(workspaceName: string, exportedAt: Date): string {
  return `${fileStem(workspaceName)}-record-${exportedAt.toISOString().slice(0, 10)}.jsonl`;
}

/** A template as the file people keep: indented, with a final newline. */
export function templateFileText(template: WorkspaceTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Whether the server refused the record because the sign-in is too old: the record needs a
 * passkey sign-in from the last 300 seconds.
 */
export function needsFreshSignIn(error: Error | null): boolean {
  return (
    error instanceof ApiError && error.code === "forbidden" && error.detail === "sign_in_again"
  );
}

export type TemplateFile =
  | { ok: true; template: WorkspaceTemplate }
  | { ok: false; problem: string };

/** Longer than any template the server writes (256 wallets with their limits). */
export const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024;

/** A template file's text, checked as the server checks it, or what is wrong with it in words. */
export function readTemplateFile(text: string): TemplateFile {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "This file is not a workspace template: it is not JSON." };
  }

  const parsed = WorkspaceTemplate.safeParse(value);

  if (parsed.success) return { ok: true, template: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";

  return {
    ok: false,
    problem: `This file is not a workspace template this server can read: ${issue?.message ?? "it does not match"}${where}.`,
  };
}

/** The name a copy starts with: the source's, marked, within the 64 characters a name may have. */
export function copyName(sourceName: string): string {
  const suffix = " (copy)";

  return `${sourceName.slice(0, 64 - suffix.length).trimEnd()}${suffix}`;
}

/**
 * The reminder about the admin threshold: a new workspace has one approver, so it starts at 1,
 * whatever the template's was.
 */
export function thresholdReminder(templateAdminThreshold: number): string {
  const start =
    "Admin changes in this workspace need 1 approval until you change it: you are its only approver.";

  if (templateAdminThreshold <= 1) return start;

  return `${start} The template's workspace needed ${templateAdminThreshold}; raise it to that once ${templateAdminThreshold} approvers have joined.`;
}

/** Saves text as a file through the browser's download, without leaving the page. */
export function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The download has its own copy once started; the object URL is not needed after this task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
