# PRRA Bot

PRRA Bot is an installable GitHub App. When its owner mentions `@prra-bot` in a pull request conversation, it starts a durable Vercel Workflow, reviews the exact commit in an isolated Vercel Sandbox, and updates a PR comment when the review finishes.

The webhook request returns immediately with `202 Accepted`; it does not wait for the review.

## Setup

1. Copy `.env.example` to `.env.local` and configure:
   - `GITHUB_WEBHOOK_SECRET`: the secret configured on the GitHub webhook.
   - `GITHUB_APP_ID`: the GitHub App ID.
   - `GITHUB_APP_PRIVATE_KEY`: the App private key in PEM format. Escaped `\\n` newlines are supported.
   - `GITHUB_APP_SLUG`: the mention name without `@`; defaults to `prra-bot`.
   - `GITHUB_ALLOWED_USER_ID`: the only numeric GitHub user ID allowed to trigger a review.
   - `CLAUDE_CODE_OAUTH_TOKEN`: a Claude Code OAuth token created with `claude setup-token`.
2. Install and run locally:

   ```bash
   pnpm install
   pnpm dev
   ```

3. Create a GitHub App with these repository permissions:
   - Contents: read-only
   - Issues: read and write
   - Pull requests: read and write
4. Set its webhook URL to `https://<deployment>/api/github/webhook`, use `application/json`, and subscribe to `Issue comment` events.
5. Install the App on any repositories where it should be available. No repository owner or name is configured in this project.

Only a newly-created comment by `GITHUB_ALLOWED_USER_ID` that contains `@<GITHUB_APP_SLUG>` starts a review, and only when the comment belongs to a pull request. All other events return without creating a Sandbox. During review, Sandbox network access is reduced to `api.anthropic.com`; the real Claude token is injected by the network policy and is never placed inside the sandbox.
