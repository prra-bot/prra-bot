import { createHmac, timingSafeEqual } from 'node:crypto';
import { start } from 'workflow/api';

import { reviewPullRequest, type ReviewPullRequestInput } from '@/workflows/review-pull-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const APP_SLUG = /^[A-Za-z0-9-]+$/;

export async function POST(request: Request) {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('GITHUB_WEBHOOK_SECRET is not configured');
    return Response.json({ error: 'Server is not configured' }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  const expected = `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  const signatureBuffer = Buffer.from(signature ?? '');
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = request.headers.get('x-github-event');
  if (event === 'ping') {
    return Response.json({ ok: true });
  }
  if (event !== 'issue_comment') {
    return Response.json({ ignored: true, reason: 'unsupported event' }, { status: 202 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  if (body.action !== 'created') {
    return Response.json({ ignored: true, reason: 'unsupported action' }, { status: 202 });
  }

  const repository = body.repository as Record<string, unknown> | undefined;
  const ownerObject = repository?.owner as Record<string, unknown> | undefined;
  const issue = body.issue as Record<string, unknown> | undefined;
  const comment = body.comment as Record<string, unknown> | undefined;
  const commentUser = comment?.user as Record<string, unknown> | undefined;
  const installation = body.installation as Record<string, unknown> | undefined;
  const owner = ownerObject?.login;
  const repo = repository?.name;
  const prNumber = issue?.number;
  const commentId = comment?.id;
  const commentBody = comment?.body;
  const commenterId = commentUser?.id;
  const installationId = installation?.id;

  if (
    typeof owner !== 'string' || !REPOSITORY_PART.test(owner) ||
    typeof repo !== 'string' || !REPOSITORY_PART.test(repo) ||
    typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber < 1 ||
    !issue?.pull_request ||
    typeof commentId !== 'number' || !Number.isSafeInteger(commentId) || commentId < 1 ||
    typeof commentBody !== 'string' ||
    typeof commenterId !== 'number' || !Number.isSafeInteger(commenterId) || commenterId < 1 ||
    typeof installationId !== 'number' || !Number.isSafeInteger(installationId) || installationId < 1
  ) {
    return Response.json({ ignored: true, reason: 'not a pull request comment' }, { status: 202 });
  }

  const allowedUserId = process.env.GITHUB_ALLOWED_USER_ID?.trim();
  const appSlug = process.env.GITHUB_APP_SLUG?.trim() || 'prra-bot';
  if (!allowedUserId || !/^[1-9]\d*$/.test(allowedUserId) || !APP_SLUG.test(appSlug)) {
    console.error('GITHUB_ALLOWED_USER_ID or GITHUB_APP_SLUG is not configured correctly');
    return Response.json({ error: 'Server is not configured' }, { status: 500 });
  }

  if (String(commenterId) !== allowedUserId) {
    return Response.json({ ignored: true, reason: 'unauthorized commenter' }, { status: 202 });
  }

  const mentionPattern = new RegExp(`(^|[^A-Za-z0-9-])@${appSlug}(?=$|[^A-Za-z0-9-])`, 'i');
  if (!mentionPattern.test(commentBody)) {
    return Response.json({ ignored: true, reason: 'bot was not mentioned' }, { status: 202 });
  }

  const input: ReviewPullRequestInput = {
    owner,
    repo,
    prNumber,
    commentId,
    installationId,
    deliveryId: request.headers.get('x-github-delivery') ?? crypto.randomUUID(),
  };
  const run = await start(reviewPullRequest, [input]);

  return Response.json({ accepted: true, runId: run.runId }, { status: 202 });
}
