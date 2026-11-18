# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: hippocampus.spec.ts >> Hippocampus Enterprise AI Onboarding Mentor — Phase 1-3 E2E Suite >> 3. Phase 2 Hybrid RAG Playground & Agentic Tool Calling executes and cites sources
- Location: e2e/hippocampus.spec.ts:70:3

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | 
  3   | test.describe('Hippocampus Enterprise AI Onboarding Mentor — Phase 1-3 E2E Suite', () => {
  4   |   test('1. Landing Page & Interactive RAG Preview renders and switches workspace views', async ({
  5   |     page,
  6   |   }) => {
  7   |     await page.goto('/');
  8   |     await expect(
  9   |       page.getByRole('heading', {
  10  |         name: /Zero-friction engineering onboarding/i,
  11  |       })
  12  |     ).toBeVisible();
  13  | 
  14  |     // Open Workspace Console
  15  |     await page
  16  |       .getByRole('button', { name: /Launch Workspace Console/i })
  17  |       .first()
  18  |       .click();
  19  | 
  20  |     await expect(
  21  |       page.getByRole('heading', { name: 'Overview Dashboard' })
  22  |     ).toBeVisible();
  23  |   });
  24  | 
  25  |   test('2. Phase 3 RBAC Enforcement: Role Switcher filters documents and blocks unauthorized deletion', async ({
  26  |     page,
  27  |     request,
  28  |   }) => {
  29  |     // Verify API-level RBAC document filtering
  30  |     const adminDocsRes = await request.get('/api/documents', {
  31  |       headers: { 'x-hippocampus-role': 'Admin' },
  32  |     });
  33  |     expect(adminDocsRes.ok()).toBeTruthy();
  34  |     const adminDocsData = await adminDocsRes.json();
  35  | 
  36  |     const engineerDocsRes = await request.get('/api/documents', {
  37  |       headers: { 'x-hippocampus-role': 'Engineer' },
  38  |     });
  39  |     expect(engineerDocsRes.ok()).toBeTruthy();
  40  |     const engineerDocsData = await engineerDocsRes.json();
  41  | 
  42  |     // Engineer should see strictly fewer documents than Admin (Admin/Manager tiers redacted)
  43  |     expect(adminDocsData.documents.length).toBeGreaterThan(
  44  |       engineerDocsData.documents.length
  45  |     );
  46  | 
  47  |     // Engineer attempting to delete a document must receive 403 Forbidden
  48  |     const deleteAttempt = await request.delete('/api/documents/1', {
  49  |       headers: { 'x-hippocampus-role': 'Engineer' },
  50  |     });
  51  |     expect(deleteAttempt.status()).toBe(403);
  52  | 
  53  |     // UI Role Switcher test
  54  |     await page.goto('/');
  55  |     await page
  56  |       .getByRole('button', { name: /Launch Workspace Console/i })
  57  |       .first()
  58  |       .click();
  59  | 
  60  |     const roleGroup = page.getByRole('group', { name: 'RBAC Role Switcher' });
  61  |     await expect(roleGroup).toBeVisible();
  62  |     await roleGroup.getByRole('button', { name: 'Engineer' }).click();
  63  | 
  64  |     await page.getByRole('button', { name: 'Knowledge Sources' }).click();
  65  |     await expect(
  66  |       page.getByText(/Engineer visibility \(Engineer tier only\)/i)
  67  |     ).toBeVisible();
  68  |   });
  69  | 
  70  |   test('3. Phase 2 Hybrid RAG Playground & Agentic Tool Calling executes and cites sources', async ({
  71  |     request,
  72  |   }) => {
  73  |     const chatRes = await request.post('/api/chat', {
  74  |       headers: {
  75  |         'Content-Type': 'application/json',
  76  |         'x-hippocampus-role': 'Admin',
  77  |       },
  78  |       data: {
  79  |         query:
  80  |           'Check Jira ticket ENG-1042 and explain how to fix ERR_SAML_SIGNATURE_SKEW',
  81  |         channel: 'Playground',
  82  |         bypassCache: true,
  83  |         searchMode: 'hybrid_rrf',
  84  |       },
  85  |     });
  86  | 
> 87  |     expect(chatRes.ok()).toBeTruthy();
      |                          ^ Error: expect(received).toBeTruthy()
  88  |     const body = await chatRes.json();
  89  |     expect(body.searchMode).toBe('hybrid_rrf');
  90  |     expect(Array.isArray(body.chunks)).toBeTruthy();
  91  |     expect(body.chunks.length).toBeGreaterThan(0);
  92  |     expect(Array.isArray(body.toolCalls)).toBeTruthy();
  93  |     expect(body.toolCalls.length).toBeGreaterThan(0);
  94  |     expect(body.toolCalls[0].toolName).toBe('fetchJiraTicket');
  95  |   });
  96  | 
  97  |   test('4. Phase 1 Slack Webhook Fail-Safe & Retry Deduplication returns immediate 200 OK', async ({
  98  |     request,
  99  |   }) => {
  100 |     const duplicateRetryRes = await request.post('/api/slack/events', {
  101 |       headers: {
  102 |         'Content-Type': 'application/json',
  103 |         'x-hippocampus-simulator': 'true',
  104 |         'x-slack-retry-num': '2',
  105 |       },
  106 |       data: {
  107 |         type: 'event_callback',
  108 |         event_id: 'Ev_E2E_RETRY_TEST',
  109 |         event: {
  110 |           type: 'app_mention',
  111 |           channel: '#eng-onboarding',
  112 |           user: '@alex.chen',
  113 |           text: '@Hippocampus How do I configure SSO?',
  114 |         },
  115 |       },
  116 |     });
  117 | 
  118 |     expect(duplicateRetryRes.status()).toBe(200);
  119 |     const body = await duplicateRetryRes.json();
  120 |     expect(body.ok).toBe(true);
  121 |     expect(body.status).toBe('duplicate_retry_suppressed');
  122 |   });
  123 | });
  124 | 
```