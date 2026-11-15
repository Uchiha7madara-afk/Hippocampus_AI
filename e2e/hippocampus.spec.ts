import { expect, test } from '@playwright/test';

test.describe('Hippocampus Enterprise AI Onboarding Mentor — Phase 1-3 E2E Suite', () => {
  test('1. Landing Page & Interactive RAG Preview renders and switches workspace views', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', {
        name: /Zero-friction engineering onboarding/i,
      })
    ).toBeVisible();

    // Open Workspace Console
    await page
      .getByRole('button', { name: /Launch Workspace Console/i })
      .first()
      .click();

    await expect(
      page.getByRole('heading', { name: 'Overview Dashboard' })
    ).toBeVisible();
  });

  test('2. Phase 3 RBAC Enforcement: Role Switcher filters documents and blocks unauthorized deletion', async ({
    page,
    request,
  }) => {
    // Verify API-level RBAC document filtering
    const adminDocsRes = await request.get('/api/documents', {
      headers: { 'x-hippocampus-role': 'Admin' },
    });
    expect(adminDocsRes.ok()).toBeTruthy();
    const adminDocsData = await adminDocsRes.json();

    const engineerDocsRes = await request.get('/api/documents', {
      headers: { 'x-hippocampus-role': 'Engineer' },
    });
    expect(engineerDocsRes.ok()).toBeTruthy();
    const engineerDocsData = await engineerDocsRes.json();

    // Engineer should see strictly fewer documents than Admin (Admin/Manager tiers redacted)
    expect(adminDocsData.documents.length).toBeGreaterThan(
      engineerDocsData.documents.length
    );

    // Engineer attempting to delete a document must receive 403 Forbidden
    const deleteAttempt = await request.delete('/api/documents/1', {
      headers: { 'x-hippocampus-role': 'Engineer' },
    });
    expect(deleteAttempt.status()).toBe(403);

    // UI Role Switcher test
    await page.goto('/');
    await page
      .getByRole('button', { name: /Launch Workspace Console/i })
      .first()
      .click();

    const roleGroup = page.getByRole('group', { name: 'RBAC Role Switcher' });
    await expect(roleGroup).toBeVisible();
    await roleGroup.getByRole('button', { name: 'Engineer' }).click();

    await page.getByRole('button', { name: 'Knowledge Sources' }).click();
    await expect(
      page.getByText(/Engineer visibility \(Engineer tier only\)/i)
    ).toBeVisible();
  });

  test('3. Phase 2 Hybrid RAG Playground & Agentic Tool Calling executes and cites sources', async ({
    request,
  }) => {
    const chatRes = await request.post('/api/chat', {
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-role': 'Admin',
      },
      data: {
        query:
          'Check Jira ticket ENG-1042 and explain how to fix ERR_SAML_SIGNATURE_SKEW',
        channel: 'Playground',
        bypassCache: true,
        searchMode: 'hybrid_rrf',
      },
    });

    expect(chatRes.ok()).toBeTruthy();
    const body = await chatRes.json();
    expect(body.searchMode).toBe('hybrid_rrf');
    expect(Array.isArray(body.chunks)).toBeTruthy();
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(Array.isArray(body.toolCalls)).toBeTruthy();
    expect(body.toolCalls.length).toBeGreaterThan(0);
    expect(body.toolCalls[0].toolName).toBe('fetchJiraTicket');
  });

  test('4. Phase 1 Slack Webhook Fail-Safe & Retry Deduplication returns immediate 200 OK', async ({
    request,
  }) => {
    const duplicateRetryRes = await request.post('/api/slack/events', {
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-simulator': 'true',
        'x-slack-retry-num': '2',
      },
      data: {
        type: 'event_callback',
        event_id: 'Ev_E2E_RETRY_TEST',
        event: {
          type: 'app_mention',
          channel: '#eng-onboarding',
          user: '@alex.chen',
          text: '@Hippocampus How do I configure SSO?',
        },
      },
    });

    expect(duplicateRetryRes.status()).toBe(200);
    const body = await duplicateRetryRes.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('duplicate_retry_suppressed');
  });
});
