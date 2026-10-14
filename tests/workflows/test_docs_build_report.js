const assert = require('node:assert/strict');
const test = require('node:test');
const { diagnostics, renderReport, reportPullRequest } = require('../../.github/scripts/docs-build-report.js');

const run = {
  id: 123, run_attempt: 1, workflow_id: 9, event: 'pull_request',
  conclusion: 'failure', head_sha: 'abcdef123456', head_branch: 'docs-change',
  html_url: 'https://github.com/example/docs/actions/runs/123',
  head_repository: { id: 7, owner: { login: 'contributor' } },
  pull_requests: [{ number: 17 }],
};

function fixture({ previous, success = false, newer = false, attempt = false,
  stale = false, closed = false, fork = false, unavailable = false } = {}) {
  const current = { ...run, conclusion: success ? 'success' : 'failure',
    pull_requests: fork ? [] : run.pull_requests };
  const calls = [];
  const pr = { number: 17, state: closed ? 'closed' : 'open',
    head: { sha: stale ? 'different-commit' : run.head_sha } };
  const github = {
    rest: {
      pulls: { list() {}, get: async args => {
        assert.equal(args.pull_number, 17);
        return { data: pr };
      } },
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: [{ ...current,
          id: newer ? 124 : current.id, run_attempt: attempt ? 2 : 1 }] } }),
        listJobsForWorkflowRunAttempt() {},
        downloadJobLogsForWorkflowRun: async () => {
          if (unavailable) throw new Error('Expired logs');
          return { data: "2026-10-09T10:00:00.000Z docs/network.md: WARNING: document isn't included in any toctree [toc.not_included]\n" };
        },
      },
      issues: {
        listComments() {},
        updateComment: async args => calls.push({ update: args }),
        createComment: async args => calls.push({ create: args }),
      },
    },
    paginate: async (method, args) => {
      if (method === github.rest.pulls.list) {
        assert.equal(args.head, 'contributor:docs-change');
        return [pr];
      }
      if (method === github.rest.actions.listJobsForWorkflowRunAttempt) {
        assert.equal(args.attempt_number, 1);
        return [{ id: 88, name: 'build', steps: [{ name: 'Test docs', conclusion: 'failure' }] }];
      }
      return previous ? [{ id: 99, user: { login: 'github-actions[bot]' },
        body: '<!-- docs-build-report -->\nOld failure' }] : [];
    },
  };
  return { github, calls, context: { repo: { owner: 'example', repo: 'docs' },
    payload: { workflow_run: current } }, core: { warning() {} } };
}

test('reports preserve the original warning wording and severity', () => {
  const text = "docs/alternator/network.md: WARNING: document isn't included in any toctree [toc.not_included]";
  const body = renderReport(run, text);
  assert.ok(body.includes('<pre>' + text + '</pre>'));
});

test('diagnostics strip timestamps and colors, deduplicate warnings, and retain the failure tail', () => {
  const line = '2026-10-09T10:00:00.000Z \x1b[31mdocs/page.md: WARNING: missing reference\x1b[0m';
  const text = diagnostics('', [line, line, 'error: dependency install failed'].join('\n'), true);
  assert.equal(text.split('Build log tail:')[0].match(/WARNING:/g).length, 1);
  assert.doesNotMatch(text, /\x1b|2026-10-09T/);
  assert.match(text, /dependency install failed/);
});

test('warnings file retains multiline diagnostic context', () => {
  assert.equal(diagnostics('WARNING: bad directive\n  offending source\n', 'progress', false),
    'WARNING: bad directive\n  offending source');
});

test('warnings do not hide errors earlier in the build log', () => {
  const warning = 'WARNING: missing reference';
  const log = ['ERROR: early failure', warning, ...Array(30).fill('progress')].join('\n');
  const text = diagnostics(warning, log, true);
  const messages = text.split('Build log tail:')[0];
  assert.match(messages, /ERROR: early failure/);
  assert.equal(messages.match(/WARNING: missing reference/g).length, 1);
});

test('PR reports preserve the complete multiline diagnostics repeated by the summary step', () => {
  const log = 'Build output\nDocs build diagnostics\nWARNING: invalid directive\n'
    + 'unknown option: example\n\n.. code-block:: text\n   :example: true\n'
    + 'End of docs build diagnostics\nPost-job cleanup';
  assert.equal(diagnostics('', log, true), 'WARNING: invalid directive\n'
    + 'unknown option: example\n\n.. code-block:: text\n   :example: true');
});

test('untrusted diagnostic text cannot escape the preformatted block or mention users', () => {
  const body = renderReport(run, '</pre><script>alert(1)</script> @someone ```');
  assert.doesNotMatch(body, /<script>|@someone/);
  assert.match(body, /&lt;\/pre&gt;/);
  assert.match(body, /&#64;someone/);
});

test('even escaped oversized diagnostics fit in a GitHub comment', () => {
  const body = renderReport(run, '&'.repeat(100_000));
  assert.ok(body.length < 65_536);
  assert.match(body, /Report truncated/);
});

test('failed fork builds create a report using GitHub PR metadata', async () => {
  const data = fixture({ fork: true });
  await reportPullRequest(data);
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].create.issue_number, 17);
  assert.match(data.calls[0].create.body, /Failed step: Test docs/);
});

test('subsequent failures update the existing report', async () => {
  const data = fixture({ previous: true });
  await reportPullRequest(data);
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].update.comment_id, 99);
});

test('successful builds clear an existing failure report without creating new comments', async () => {
  const data = fixture({ previous: true, success: true });
  await reportPullRequest(data);
  assert.match(data.calls[0].update.body, /Docs build passed/);
  assert.doesNotMatch(data.calls[0].update.body, /WARNING/);
  const clean = fixture({ success: true });
  await reportPullRequest(clean);
  assert.equal(clean.calls.length, 0);
});

for (const option of ['stale', 'closed', 'newer', 'attempt']) {
  test(`${option} runs cannot overwrite the current PR report`, async () => {
    const data = fixture({ [option]: true });
    await reportPullRequest(data);
    assert.equal(data.calls.length, 0);
  });
}

test('unavailable logs still produce a report linking to the failed build', async () => {
  const data = fixture({ unavailable: true });
  await reportPullRequest(data);
  assert.match(data.calls[0].create.body, /Build log unavailable/);
  assert.match(data.calls[0].create.body, /actions\/runs\/123/);
});
