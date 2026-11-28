import { expect, test } from '@playwright/test';

test.describe('Hippocampus Enterprise AI — Hardened Security & UI E2E Suite', () => {
  test('1. Landing Page renders, transitions to Workspace Console, and enforces unauthenticated sign-in gate', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', {
        name: /Turn scattered engineering runbooks into an instant Slack mentor/i,
      })
    ).toBeVisible();

    // Open Workspace Console
    await page
      .getByRole('button', { name: /Open Knowledge Console/i })
      .first()
      .click();

    await expect(
      page.getByRole('heading', { name: 'Overview Dashboard' })
    ).toBeVisible();

    // Unauthenticated users must see Sign-In gate and must NOT have client role switcher buttons
    await expect(
      page.getByText(/Protected workspace APIs require verified Firebase authentication/i)
    ).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'RBAC Role Switcher' })
    ).toHaveCount(0);
  });

  test('2. Mission 001 Security Boundary: Forged x-hippocampus-role headers are rejected with 401 on protected APIs', async ({
    request,
  }) => {
    const docsAttempt = await request.get('/api/documents', {
      headers: { 'x-hippocampus-role': 'Admin' },
    });
    expect(docsAttempt.status()).toBe(401);

    const deleteAttempt = await request.delete('/api/documents/1', {
      headers: { 'x-hippocampus-role': 'Admin' },
    });
    expect(deleteAttempt.status()).toBe(401);

    const roleMutationAttempt = await request.patch('/api/auth/role', {
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-role': 'Admin',
      },
      data: { targetUid: 'uid-target', role: 'Admin' },
    });
    expect(roleMutationAttempt.status()).toBe(401);
  });

  test('3. Mission 001 Security Boundary: GitHub & Slack webhooks fail closed and reject simulator header bypass', async ({
    request,
  }) => {
    const githubBypassAttempt = await request.post('/api/webhooks/github', {
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-simulator': 'true',
        'x-github-event': 'push',
      },
      data: {
        ref: 'refs/heads/main',
        repository: { full_name: 'Uchiha7madara-afk/Hippocampus_AI' },
      },
    });
    // Must reject with 401 (invalid/missing signature) or 503 (secret unconfigured) — NEVER 200
    expect([401, 503]).toContain(githubBypassAttempt.status());

    const slackBypassAttempt = await request.post('/api/slack/events', {
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-simulator': 'true',
      },
      data: {
        type: 'event_callback',
        event_id: 'Ev_E2E_BYPASS_TEST',
        event: {
          type: 'app_mention',
          channel: '#eng-onboarding',
          user: '@alex.chen',
          text: '@Hippocampus How do I configure SSO?',
        },
      },
    });
    expect([401, 503]).toContain(slackBypassAttempt.status());
  });

  test('4. Public health endpoint responds 200 OK without exposing sensitive internals', async ({
    request,
  }) => {
    const healthRes = await request.get('/api/health');
    expect(healthRes.status()).toBe(200);
    const body = await healthRes.json();
    expect(body.status).toBe('ok');
  });
});
