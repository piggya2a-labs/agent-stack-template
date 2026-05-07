/**
 * github-auth.ts — GitHub authentication helper for Trigger.dev tasks.
 *
 * Uses a Personal Access Token (PAT) stored in GITHUB_TOKEN env var.
 * For multi-tenant GitHub App auth, replace with your own App credentials.
 *
 * Environment variables required:
 *   GITHUB_TOKEN — Personal Access Token with Issues (read/write) permission
 */

export async function getInstallationToken(_installationId: number | string): Promise<string> {
  // Template version: uses a single PAT instead of GitHub App installation tokens.
  // To use GitHub App auth, implement JWT generation and exchange here.
  const pat = process.env["GITHUB_TOKEN"] ?? "";
  if (!pat) throw new Error("GITHUB_TOKEN is not set");
  return pat;
}
