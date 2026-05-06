/**
 * github-auth.ts — GitHub authentication helper.
 * Uses a Personal Access Token (PAT) from GITHUB_TOKEN env var.
 */
export function getGitHubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? "";
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}
