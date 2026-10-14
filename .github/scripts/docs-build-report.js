const fs = require('node:fs');
const path = require('node:path');

const MARKER = '<!-- docs-build-report -->';
const MAX_LOG = 2_000_000;
const MAX_REPORT = 12_000;

function limitLog(text) {
  return text.length > MAX_LOG ? text.slice(0, MAX_LOG) + '\n[Log truncated]\n'
    + text.slice(-32_000) : text;
}

function clean(text) {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s?/gm, '');
}

function diagnostics(warnings, log, failed) {
  const plain = clean(log);
  // The summary step repeats the complete diagnostics, including multiline errors.
  const start = plain.lastIndexOf('\nDocs build diagnostics\n');
  const end = plain.indexOf('\nEnd of docs build diagnostics', start);
  if (!warnings.trim() && start >= 0 && end > start) {
    return plain.slice(start + '\nDocs build diagnostics\n'.length, end);
  }
  const lines = plain.split('\n');
  const warningText = clean(warnings).trim();
  const known = new Set(warningText.split('\n'));
  const additional = [...new Set(lines.filter(line =>
    /\b(?:WARNING|ERROR|CRITICAL):|^error:/i.test(line)
  ))].filter(line => !known.has(line));
  const messages = [warningText, ...additional].filter(Boolean).join('\n');
  const tail = failed ? lines.filter(line => line.trim()).slice(-25).join('\n') : '';
  return clean(messages) + (tail ? '\n\nBuild log tail:\n' + tail : '');
}

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;');
}

function renderReport(run, text) {
  const status = { success: 'passed', failure: 'failed' }[run.conclusion] || run.conclusion;
  const shortened = text.length > MAX_REPORT;
  const displayed = escape(text.slice(0, MAX_REPORT));
  const output = [MARKER, `### Docs build ${status}`, '',
    `Commit: \`${run.head_sha.slice(0, 7)}\`. [Build log](${run.html_url}).`, ''];
  if (text.trim()) output.push('<pre>' + displayed + '</pre>', '');
  else if (run.conclusion !== 'success') output.push(
    'No Sphinx diagnostics were captured. Check the failed step in the build log.', ''
  );
  if (shortened) output.push('Report truncated. See the build log for all diagnostics.', '');
  return output.join('\n');
}

function readLog(filename) {
  if (!fs.existsSync(filename)) return '';
  return limitLog(fs.readFileSync(filename, 'utf8'));
}

async function writeSummary({ core }) {
  const directory = process.env.RUNNER_TEMP;
  const outcome = process.env.DOCS_BUILD_OUTCOME;
  const warnings = readLog(path.join(directory, 'docs-warnings.log'));
  const log = readLog(path.join(directory, 'docs-build.log'));
  const text = diagnostics(warnings, log, outcome === 'failure');
  const run = {
    conclusion: outcome === 'skipped' ? 'not run' : outcome,
    head_sha: process.env.GITHUB_SHA,
    html_url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      + `/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  core.info('\nDocs build diagnostics\n' + (text.trim()
    || (outcome === 'success' ? 'No warnings or errors found.' : 'No diagnostics captured.'))
    + '\nEnd of docs build diagnostics');
  await core.summary.addRaw(renderReport(run, text)).write();
}

async function readBuildDiagnostics({ github, repository, run, core }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...repository, run_id: run.id, attempt_number: run.run_attempt, per_page: 100,
  });
  const build = jobs.find(job => job.name === 'build');
  if (!build) return '';
  const failed = (build.steps || []).find(step => step.conclusion === 'failure');
  const prefix = failed ? `Failed step: ${failed.name}\n\n` : '';
  try {
    const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({
      ...repository, job_id: build.id,
    });
    const log = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return prefix + diagnostics('', limitLog(log), true);
  } catch (error) {
    core.warning(`Could not read the build log: ${error.message}`);
    return prefix + 'Build log unavailable. Use the link above to inspect the failed step.';
  }
}

async function reportPullRequest({ github, context, core }) {
  const run = context.payload.workflow_run;
  const repository = context.repo;
  if (run.event !== 'pull_request') return;
  // Resolve the PR from GitHub metadata, never from PR-controlled files or logs.
  let candidates = run.pull_requests || [];
  if (!candidates.length && run.head_repository) {
    candidates = await github.paginate(github.rest.pulls.list, {
      ...repository, state: 'open',
      head: `${run.head_repository.owner.login}:${run.head_branch}`, per_page: 100,
    });
  }
  for (const candidate of candidates) {
    const { data: pr } = await github.rest.pulls.get({
      ...repository, pull_number: candidate.number,
    });
    if (pr.state !== 'open' || pr.head.sha !== run.head_sha) continue;
    const { data: latest } = await github.rest.actions.listWorkflowRuns({
      ...repository, workflow_id: run.workflow_id, event: 'pull_request',
      head_sha: run.head_sha, per_page: 100,
    });
    if (latest.workflow_runs.some(other =>
      other.head_repository?.id === run.head_repository?.id
      && other.head_branch === run.head_branch
      && (other.id > run.id || (other.id === run.id && other.run_attempt > run.run_attempt))
    )) continue;
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repository, issue_number: pr.number, per_page: 100,
    });
    const previous = comments.find(comment =>
      comment.user?.login === 'github-actions[bot]' && (comment.body || '').startsWith(MARKER)
    );
    if (run.conclusion === 'success' && !previous) continue;
    const text = run.conclusion === 'success' ? ''
      : await readBuildDiagnostics({ github, repository, run, core });
    const body = renderReport(run, text);
    if (previous) await github.rest.issues.updateComment({
      ...repository, comment_id: previous.id, body,
    });
    else await github.rest.issues.createComment({
      ...repository, issue_number: pr.number, body,
    });
  }
}

module.exports = { clean, diagnostics, renderReport, writeSummary, reportPullRequest };
