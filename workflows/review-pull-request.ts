import { createAppAuth } from '@octokit/auth-app';
import { Sandbox, type NetworkPolicyRule } from '@vercel/sandbox';

const REPO_DIR = '/vercel/sandbox/repo';
const CLAUDE_CODE_VERSION = '2.1.278';
const PLACEHOLDER_TOKEN = 'sk-ant-oat01-placeholder';
const MAX_COMMENT_LENGTH = 60_000;

export interface ReviewPullRequestInput {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  installationId: number;
  deliveryId: string;
}

interface ReviewTarget extends ReviewPullRequestInput {
  baseRef: string;
  baseSha: string;
  headSha: string;
}

interface GitHubComment {
  id: number;
  body?: string;
}

function reviewMarker(input: ReviewPullRequestInput) {
  return `<!-- prra-bot-review:${input.commentId} -->`;
}

async function createInstallationToken(installationId: number) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !privateKey) {
    throw new Error('GitHub App credentials are not configured');
  }

  const auth = createAppAuth({ appId, privateKey, installationId });
  return (await auth({ type: 'installation' })).token;
}

async function githubRequest(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}`);
  }
  return response;
}

async function getReviewTarget(input: ReviewPullRequestInput): Promise<ReviewTarget> {
  'use step';

  const token = await createInstallationToken(input.installationId);
  const response = await githubRequest(
    token,
    `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`,
  );
  const pullRequest = await response.json() as {
    base?: { ref?: unknown; sha?: unknown };
    head?: { sha?: unknown };
  };
  const baseRef = pullRequest.base?.ref;
  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;

  if (
    typeof baseRef !== 'string' || baseRef.length === 0 || baseRef.length > 255 ||
    typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(baseSha) ||
    typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)
  ) {
    throw new Error('GitHub returned invalid pull request metadata');
  }

  return { ...input, baseRef, baseSha, headSha };
}

async function ensureProgressComment(input: ReviewTarget) {
  'use step';

  const token = await createInstallationToken(input.installationId);
  const marker = reviewMarker(input);
  let page = 1;

  while (true) {
    const response = await githubRequest(
      token,
      `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/comments?per_page=100&page=${page}`,
    );
    const comments = await response.json() as GitHubComment[];
    const existing = comments.find((comment) => comment.body?.includes(marker));
    if (existing) return existing.id;
    if (comments.length < 100) break;
    page += 1;
  }

  const response = await githubRequest(
    token,
    `/repos/${input.owner}/${input.repo}/issues/${input.prNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: `${marker}\n## PRRA Review\n\n⏳ Review is running for commit \`${input.headSha.slice(0, 12)}\`.`,
      }),
    },
  );
  const comment = await response.json() as GitHubComment;
  return comment.id;
}

async function runReview(input: ReviewTarget) {
  'use step';

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not configured');
  const githubToken = await createInstallationToken(input.installationId);

  const anthropicNetworkRules: NetworkPolicyRule[] = [{
    match: {
      headers: [{
        key: { exact: 'authorization' },
        value: { exact: `Bearer ${PLACEHOLDER_TOKEN}` },
      }],
    },
    transform: [{ headers: { authorization: `Bearer ${oauthToken}` } }],
  }];

  const sandbox = await Sandbox.create({
    runtime: 'node24',
    timeout: 15 * 60 * 1000,
    networkPolicy: {
      allow: {
        'api.anthropic.com': anthropicNetworkRules,
        '*': [],
      },
    },
  });

  try {
    const run = async (cmd: string, args: string[], cwd?: string) => {
      const result = await sandbox.runCommand({ cmd, args, cwd });
      if (result.exitCode !== 0) {
        throw new Error(`${cmd} failed with exit code ${result.exitCode}`);
      }
      return result;
    };

    await run('npm', ['install', '-g', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`]);

    const cloneUrl = `https://x-access-token:${githubToken}@github.com/${input.owner}/${input.repo}.git`;
    await run('git', ['clone', '--branch', input.baseRef, cloneUrl, REPO_DIR]);
    await run('git', ['fetch', 'origin', `pull/${input.prNumber}/head:pr-${input.prNumber}`], REPO_DIR);
    await run('git', ['checkout', `pr-${input.prNumber}`], REPO_DIR);

    const checkedOutHead = (await (await run('git', ['rev-parse', 'HEAD'], REPO_DIR)).stdout()).trim();
    if (checkedOutHead !== input.headSha) {
      throw new Error('The pull request head changed before review started');
    }

    await run('git', ['cat-file', '-e', `${input.baseSha}^{commit}`], REPO_DIR);
    await run('git', ['remote', 'remove', 'origin'], REPO_DIR);
    await sandbox.updateNetworkPolicy({
      allow: { 'api.anthropic.com': anthropicNetworkRules },
    });

    const review = await sandbox.runCommand({
      cmd: 'claude',
      args: [
        '-p',
        `Review the code changes between ${input.baseSha} and HEAD. Focus on concrete bugs, security issues, regressions, and missing tests. Return concise GitHub-flavored Markdown. Cite file paths and line numbers for each finding. If there are no findings, say so explicitly.`,
        '--safe-mode',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
        '--output-format',
        'text',
      ],
      cwd: REPO_DIR,
      env: { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN },
    });
    if (review.exitCode !== 0) {
      throw new Error(`Claude Code failed with exit code ${review.exitCode}`);
    }
    const output = await review.stdout();
    if (!output.trim()) throw new Error('Claude Code returned an empty review');
    return output;
  } finally {
    await sandbox.stop();
  }
}

async function updateComment(
  input: ReviewTarget,
  commentId: number,
  status: 'completed' | 'failed',
  content: string,
) {
  'use step';

  const token = await createInstallationToken(input.installationId);
  const heading = status === 'completed'
    ? '## PRRA Review'
    : '## PRRA Review failed';
  const body = `${reviewMarker(input)}\n${heading}\n\n${content}`;
  const truncatedBody = body.length <= MAX_COMMENT_LENGTH
    ? body
    : `${body.slice(0, MAX_COMMENT_LENGTH)}\n\n_Review truncated because it exceeded the comment size limit._`;

  await githubRequest(
    token,
    `/repos/${input.owner}/${input.repo}/issues/comments/${commentId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: truncatedBody }),
    },
  );
}

export async function reviewPullRequest(input: ReviewPullRequestInput) {
  'use workflow';

  const target = await getReviewTarget(input);
  const commentId = await ensureProgressComment(target);

  try {
    const review = await runReview(target);
    await updateComment(target, commentId, 'completed', review);
    return { status: 'completed' as const, commentId };
  } catch (error) {
    await updateComment(
      target,
      commentId,
      'failed',
      `The automated review could not be completed. Check the workflow logs for delivery \`${input.deliveryId}\`.`,
    );
    throw error;
  }
}
