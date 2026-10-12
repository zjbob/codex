import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { hash, toolkitHash, writeNewJson, requiredCases } from './runtime.mjs';

const [binaryArg, outputArg, variant = 'reopened'] = process.argv.slice(2);
if (!binaryArg || !outputArg || !['base', 'reopened', 'offline', 'linked'].includes(variant)) throw new Error('Usage: node probe.mjs <codex.exe> <evidence-directory> [base|reopened|offline|linked]');
if (process.platform !== 'win32') throw Error('These acceptance tests require native Windows');
const binary = fs.realpathSync(binaryArg);
const outputDirectory = path.resolve(outputArg);
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, variant + '.json');
if (fs.existsSync(outputPath)) throw Error('Use a fresh evidence directory; result already exists');
const binarySha256 = hash(binary);
const toolkitSha256 = toolkitHash();
const root = fs.mkdtempSync(path.join(outputDirectory, 'fixture-' + variant + '-'));
const workspace = path.join(root, 'workspace');
if (variant === 'linked') {
  const repository = path.join(root, 'fixture-repository');
  const git = args => {
    const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw Error(result.stderr);
  };
  git(['init', '-q', repository]);
  fs.writeFileSync(path.join(repository, 'README.md'), 'synthetic-runtime-read\n');
  fs.writeFileSync(path.join(repository, 'patch.txt'), 'before\nremove-me\n');
  git(['-C', repository, 'add', 'README.md', 'patch.txt']);
  git(['-C', repository, '-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'Synthetic fixture']);
  git(['-C', repository, 'worktree', 'add', '--detach', '-q', workspace, 'HEAD']);
}
const outside = path.join(root, 'outside');
const own = variant === 'base' ? 'normal' : '.agents/sessions';
const networkEnabled = variant !== 'base' && variant !== 'offline';
fs.mkdirSync(path.join(workspace, own), { recursive: true });
fs.mkdirSync(path.join(workspace, '.agents'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, 'README.md'), 'synthetic-runtime-read\n');
fs.writeFileSync(path.join(workspace, 'patch.txt'), 'before\nremove-me\n');
fs.writeFileSync(path.join(workspace, '.agents', 'protected.txt'), 'protected\n');
fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside\n');
fs.symlinkSync(outside, path.join(workspace, 'escape'), 'junction');
const q = value => "'" + value.replaceAll("'", "''") + "'";
const cases = [];
const patch = (name, text, denied = false) => cases.push({ name, kind: 'patch', text: '*** Begin Patch\n' + text + '\n*** End Patch', denied });
const shell = (name, text, denied = false) => cases.push({ name, kind: 'shell', text: "$ErrorActionPreference='Stop'; " + text, denied });
const sandboxUsername = networkEnabled ? 'CodexSandboxOnline' : 'CodexSandboxOffline';
// Environment home variables can exist even when the native account profile is missing.
const userInfoScript = `const info = require('node:os').userInfo(); if (info.username.toLowerCase() !== '${sandboxUsername}'.toLowerCase() || !require('node:path').isAbsolute(info.homedir)) { throw new Error('Sandbox account profile did not resolve'); } console.log('SANDBOX-USER-INFO-PASS');`;
shell('node-user-info', `& ${q(process.execPath)} -e ${q(userInfoScript)}; if ($LASTEXITCODE -ne 0) { throw 'Node userInfo failed' }`);
shell('ordinary-read', "Get-Content -LiteralPath 'README.md'");
shell('ordinary-write-delete', "[IO.File]::WriteAllText((Join-Path $PWD 'shell.txt'),'synthetic'); Get-Content -LiteralPath 'shell.txt'; Remove-Item -LiteralPath 'shell.txt'");
shell('session-write-read-delete', `[IO.File]::WriteAllText((Join-Path $PWD ${q(own + '/shell.txt')}),'synthetic'); Get-Content -LiteralPath ${q(own + '/shell.txt')}; Remove-Item -LiteralPath ${q(own + '/shell.txt')}`);
patch('ordinary-add', '*** Add File: added.txt\n+created');
shell('ordinary-add-readback', "if ((Get-Content -LiteralPath 'added.txt' -Raw).Trim() -ne 'created') { throw 'Patch create readback mismatch' }");
patch('ordinary-added-delete', '*** Delete File: added.txt');
patch('ordinary-update', '*** Update File: patch.txt\n@@\n-before\n+after');
patch('hunk-delete', '*** Update File: patch.txt\n@@\n after\n-remove-me');
shell('ordinary-patch-readback', "if ((Get-Content -LiteralPath 'patch.txt' -Raw).Trim() -ne 'after') { throw 'Patch update/hunk removal readback mismatch' }");
patch('ordinary-delete', '*** Delete File: patch.txt');
patch('session-add', `*** Add File: ${own}/patch.txt\n+created`);
patch('session-update', `*** Update File: ${own}/patch.txt\n@@\n-created\n+updated`);
shell('session-patch-readback', `if ((Get-Content -LiteralPath ${q(own + '/patch.txt')} -Raw).Trim() -ne 'updated') { throw 'Session patch readback mismatch' }`);
patch('session-move', `*** Update File: ${own}/patch.txt\n*** Move to: ${own}/moved.txt\n@@\n-updated\n+moved`);
patch('session-delete', `*** Delete File: ${own}/moved.txt`);
shell('protected-write-denied', "[IO.File]::WriteAllText((Join-Path $PWD '.agents/protected.txt'),'WRONG')", true);
shell('protected-delete-denied', "Remove-Item -LiteralPath '.agents/protected.txt'", true);
shell('protected-rename-denied', "Rename-Item -LiteralPath '.agents' -NewName 'agents-WRONG'", true);
shell('outside-write-denied', `[IO.File]::WriteAllText(${q(path.join(outside, 'outside.txt'))},'WRONG')`, true);
shell('outside-delete-denied', `Remove-Item -LiteralPath ${q(path.join(outside, 'outside.txt'))}`, true);
shell('junction-write-denied', "[IO.File]::WriteAllText((Join-Path $PWD 'escape/outside.txt'),'WRONG')", true);
shell('junction-delete-denied', "Remove-Item -LiteralPath 'escape/outside.txt'", true);
patch('protected-patch-denied', '*** Update File: .agents/protected.txt\n@@\n-protected\n+WRONG', true);
patch('protected-patch-delete-denied', '*** Delete File: .agents/protected.txt', true);
patch('outside-patch-denied', `*** Update File: ${path.join(outside, 'outside.txt')}\n@@\n-outside\n+WRONG`, true);
patch('traversal-patch-denied', '*** Update File: ../outside/outside.txt\n@@\n-outside\n+WRONG', true);
patch('junction-patch-denied', '*** Update File: escape/outside.txt\n@@\n-outside\n+WRONG', true);
if (JSON.stringify(cases.map(x => ({ name: x.name, expected: x.denied ? 'denied' : 'allowed' }))) !== JSON.stringify(requiredCases)) throw Error('Probe cases differ from the required acceptance matrix');
let requests = 0;
const outputs = new Map();
let advertisedTools = [];
const server = http.createServer(async (req, res) => {
  if (!req.url.includes('/responses')) { res.writeHead(404); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.tools?.length) advertisedTools = body.tools;
  for (const item of body.input ?? []) if (item.type?.endsWith('call_output')) outputs.set(item.call_id, item.output);
  const id = `resp-${++requests}`;
  const events = [{ type: 'response.created', response: { id } }];
  const item = cases[requests - 1];
  if (item) {
    if (item.kind === 'patch') events.push({ type: 'response.output_item.done', item: { type: 'custom_tool_call', name: 'apply_patch', input: item.text, call_id: item.name } });
    else {
      const name = 'exec_command';
      const args = { cmd: item.text, workdir: workspace, yield_time_ms: 1000, max_output_tokens: 1500 };
      events.push({ type: 'response.output_item.done', item: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: item.name } });
    }
  } else events.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'complete', content: [{ type: 'output_text', text: 'Synthetic runtime checks complete.' }] } });
  events.push({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const args = ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '-C', workspace, '-m', 'gpt-6.1-sol',
  '-c', 'model_provider="runtime_probe"', '-c', 'model_providers.runtime_probe.name="Local synthetic runtime check"',
  '-c', `model_providers.runtime_probe.base_url="http://127.0.0.1:${server.address().port}/v1"`,
  '-c', 'model_providers.runtime_probe.wire_api="responses"', '-c', 'model_providers.runtime_probe.requires_openai_auth=false',
  '-c', 'model_providers.runtime_probe.supports_websockets=false', '-c', 'windows.sandbox="elevated"', '-c', 'approval_policy="never"',
  '-c', 'default_permissions="runtime-probe"', '-c', variant === 'base' ? 'permissions={runtime-probe={extends=":workspace"}}' : `permissions={runtime-probe={extends=":workspace",network={enabled=${networkEnabled}},filesystem={":workspace_roots"={".agents/sessions"="write"}}}}`,
  '-c', 'project_doc_max_bytes=0', '-c', 'features.code_mode=false', 'Execute the local synthetic tool checks.'];
const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => { timedOut = true; spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 180000);
const exit = await new Promise(resolve => { child.on('exit', resolve); child.on('error', error => resolve(error.message)); });
clearTimeout(timer); server.close();
const result = { binary, binarySha256, toolkitSha256, variant, networkEnabled, root, exit, timedOut, requests, advertisedTools,
  cases: cases.map(item => { const output = String(outputs.get(item.name) ?? ''); const passed = item.denied
    ? /(?:Exit code: [1-9]|Process exited with code [1-9]|patch rejected:)/i.test(output) && !/Exit code: 0|Process exited with code 0/.test(output)
    : /Exit code: 0|Process exited with code 0|Success\./.test(output); return { name: item.name, expected: item.denied ? 'denied' : 'allowed', passed, output }; }),
  protectedUnchanged: fs.existsSync(path.join(workspace, '.agents', 'protected.txt')) && fs.readFileSync(path.join(workspace, '.agents', 'protected.txt'), 'utf8') === 'protected\n',
  outsideUnchanged: fs.existsSync(path.join(outside, 'outside.txt')) && fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8') === 'outside\n',
  ordinaryRemoved: !fs.existsSync(path.join(workspace, 'patch.txt')) && !fs.existsSync(path.join(workspace, 'added.txt')), ownRemoved: !fs.existsSync(path.join(workspace, own, 'patch.txt')) && !fs.existsSync(path.join(workspace, own, 'moved.txt')),
  stdout: stdout.slice(-5000), stderr: stderr.slice(-5000) };
result.passed = toolkitHash() === toolkitSha256 && hash(binary) === binarySha256 && exit === 0 && !timedOut && result.cases.every(item => item.passed) && result.protectedUnchanged && result.outsideUnchanged && result.ordinaryRemoved && result.ownRemoved;
writeNewJson(outputPath, result);
console.log(JSON.stringify({ variant, passed: result.passed, passedCases: result.cases.filter(item => item.passed).length, totalCases: result.cases.length, protectedUnchanged: result.protectedUnchanged, outsideUnchanged: result.outsideUnchanged, failedCases: result.cases.filter(item => !item.passed), exit, timedOut, evidence: outputPath }, null, 2));
if (!result.passed) process.exitCode = 1;
