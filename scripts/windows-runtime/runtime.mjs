import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const version = JSON.parse(fs.readFileSync(path.join(directory, 'version.json'), 'utf8'));
const variants = ['base', 'reopened', 'offline', 'linked'];
export const requiredCases = Object.freeze([
  'node-user-info', 'ordinary-read', 'ordinary-write-delete', 'session-write-read-delete',
  'ordinary-add', 'ordinary-add-readback', 'ordinary-added-delete', 'ordinary-update',
  'hunk-delete', 'ordinary-patch-readback', 'ordinary-delete', 'session-add',
  'session-update', 'session-patch-readback', 'session-move', 'session-delete',
  'protected-write-denied', 'protected-delete-denied', 'protected-rename-denied',
  'outside-write-denied', 'outside-delete-denied', 'junction-write-denied',
  'junction-delete-denied', 'protected-patch-denied', 'protected-patch-delete-denied',
  'outside-patch-denied', 'traversal-patch-denied', 'junction-patch-denied',
].map(name => Object.freeze({ name, expected: name.endsWith('-denied') ? 'denied' : 'allowed' })));
export const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function toolkitHash() {
  const sum = crypto.createHash('sha256');
  for (const file of ['runtime.mjs', 'probe.mjs', 'startup.mjs', 'build.py', 'version.json']) {
    sum.update(file + '\0').update(fs.readFileSync(path.join(directory, file)));
  }
  return sum.digest('hex');
}
export const writeNewJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function replaceJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  writeNewJson(temporary, value);
  fs.renameSync(temporary, file);
}
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
export function assertOutside(parent, candidate) {
  // Resolve existing ancestors too: a new directory below a junction is not
  // necessarily outside the installation even when its spelling looks outside.
  const missing = [];
  let existing = path.resolve(candidate);
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    requireThat(parent !== existing, 'Run directory has no existing ancestor');
    existing = parent;
  }
  const projected = path.join(fs.realpathSync(existing), ...missing);
  const relative = path.relative(fs.realpathSync(parent), projected);
  requireThat(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Run directory must be outside the installed runtime');
}
export function checkBuildReceipt(runDirectory, binary, requireOriginalPath = false) {
  const file = path.join(runDirectory, 'build.json');
  const receipt = readJson(file);
  requireThat(receipt.fixCommit === version.fixCommit && receipt.sourceTag === version.sourceTag && /^[a-f0-9]{40}$/.test(receipt.sourceCommit), 'Build source identity mismatch');
  requireThat(receipt.rust.startsWith('rustc ' + version.rustVersion + ' '), 'Build toolchain mismatch');
  requireThat(receipt.binarySha256 === hash(binary), 'Executable does not match build receipt');
  if (requireOriginalPath) requireThat(fs.realpathSync(receipt.binary).toLowerCase() === fs.realpathSync(binary).toLowerCase(), 'Build receipt names another artifact');
  return hash(file);
}
export function assertPlainTree(root) {
  requireThat(!fs.lstatSync(root).isSymbolicLink(), 'Reparse/symlink path refused: ' + root);
  if (fs.statSync(root).isDirectory()) {
    for (const entry of fs.readdirSync(root)) assertPlainTree(path.join(root, entry));
  }
}
function actualVersion(binary) {
  return execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
}
function checkVersion(binary) {
  requireThat(actualVersion(binary) === 'codex-cli ' + version.cliVersion, 'CLI version mismatch');
}
function checkOfficial(root, includeCli = true) {
  for (const [relative, sha] of Object.entries(version.officialFiles)) {
    if (!includeCli && relative === 'codex.exe') continue;
    requireThat(hash(path.join(root, relative)) === sha, 'Official runtime hash mismatch: ' + relative);
  }
}
function selectedRuntime(expectedDirectory) {
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  const selected = readJson(path.join(extensions, 'extensions.json')).filter(x => x.identifier.id === 'openai.chatgpt');
  requireThat(selected.length === 1 && selected[0].version === version.extensionVersion, 'Selected VS Code extension changed');
  const runtime = fs.realpathSync(path.join(extensions, selected[0].relativeLocation, 'bin', 'windows-x86_64'));
  requireThat(runtime.toLowerCase() === fs.realpathSync(expectedDirectory).toLowerCase(), 'Runtime is not the selected VS Code extension');
  return runtime;
}
export function checkEvidence(binary, evidenceDirectory, requiredVariants = variants) {
  const binarySha256 = hash(binary);
  const toolkitSha256 = toolkitHash();
  const receipts = {};
  for (const name of [...requiredVariants, 'startup']) {
    const file = path.join(evidenceDirectory, name + '.json');
    const result = readJson(file);
    requireThat(result.passed === true && result.exit === 0 && result.timedOut === false, 'Acceptance failed: ' + name);
    requireThat(result.binarySha256 === binarySha256 && result.toolkitSha256 === toolkitSha256, 'Stale acceptance: ' + name);
    requireThat(fs.realpathSync(result.binary).toLowerCase() === fs.realpathSync(binary).toLowerCase(), 'Acceptance tested another path: ' + name);
    if (name === 'startup') {
      requireThat(result.initialized && !result.sqliteError && result.codexHomeOverride === false && result.models.includes(version.expectedModel), 'Normal-home startup/catalog failed');
    } else {
      requireThat(result.variant === name && result.networkEnabled === (name === 'reopened' || name === 'linked'), 'Wrong policy variant');
      requireThat(result.cases.length === requiredCases.length && new Set(result.cases.map(x => x.name)).size === requiredCases.length && requiredCases.every(expected => result.cases.some(actual => actual.name === expected.name && actual.expected === expected.expected && actual.passed === true)), 'Incomplete or incorrect acceptance matrix');
      requireThat(result.protectedUnchanged && result.outsideUnchanged && result.ordinaryRemoved && result.ownRemoved, 'Containment/readback invariant failed');
    }
    receipts[name] = { file: fs.realpathSync(file), sha256: hash(file) };
  }
  return { binarySha256, toolkitSha256, receipts };
}

export function prepare(installedArgument, runArgument) {
  const installedDirectory = fs.realpathSync(installedArgument);
  const runDirectory = path.resolve(runArgument);
  requireThat(!fs.existsSync(runDirectory), 'Use a new run directory');
  assertOutside(installedDirectory, runDirectory);
  assertPlainTree(installedDirectory);
  checkOfficial(installedDirectory);
  checkVersion(path.join(installedDirectory, 'codex.exe'));
  fs.mkdirSync(runDirectory, { recursive: true });
  for (const name of ['official', 'candidate']) fs.cpSync(installedDirectory, path.join(runDirectory, name), { recursive: true, errorOnExist: true, force: false });
  const state = { state: 'prepared', installedDirectory, version, created: new Date().toISOString() };
  writeNewJson(path.join(runDirectory, 'state.json'), state);
  return state;
}

function loadState(runArgument) {
  const runDirectory = fs.realpathSync(runArgument);
  const file = path.join(runDirectory, 'state.json');
  const state = readJson(file);
  requireThat(JSON.stringify(state.version) === JSON.stringify(version), 'Toolkit version manifest changed');
  return { runDirectory, file, state, candidate: path.join(runDirectory, 'candidate', 'codex.exe') };
}

function main([command, first, second]) {
  if (command === 'diagnose') {
    const binary = fs.realpathSync(first);
    console.log(JSON.stringify({ binary, version: actualVersion(binary), sha256: hash(binary), knownRepairedBuild: hash(binary) === version.validatedLocalBuildSha256 }, null, 2));
    return;
  }
  if (command === 'prepare') { console.log(JSON.stringify(prepare(first, second), null, 2)); return; }
  if (!['stage', 'validate', 'install', 'verify-installed', 'rollback'].includes(command) || !first) {
    throw Error('Usage: runtime.mjs diagnose <exe> | prepare <official-runtime-dir> <new-run-dir> | stage <run-dir> <built-exe> | validate <run-dir> <evidence-dir> | install <run-dir> | verify-installed <run-dir> <evidence-dir> | rollback <run-dir>');
  }
  const { runDirectory, file, state, candidate } = loadState(first);
  if (command === 'stage') {
    requireThat(state.state === 'prepared', 'Stage requires a prepared run');
    state.buildReceiptSha256 = checkBuildReceipt(runDirectory, second, true);
    checkVersion(second);
    checkOfficial(path.join(runDirectory, 'candidate'));
    fs.copyFileSync(second, candidate);
    state.candidateSha256 = hash(candidate);
    requireThat(checkBuildReceipt(runDirectory, candidate) === state.buildReceiptSha256, 'Copy or build receipt changed during staging');
    state.state = 'staged';
  } else if (command === 'validate') {
    requireThat(state.state === 'staged' && hash(candidate) === state.candidateSha256, 'Candidate changed or not staged');
    requireThat(checkBuildReceipt(runDirectory, candidate) === state.buildReceiptSha256, 'Build receipt changed since staging');
    checkOfficial(path.dirname(candidate), false);
    state.acceptance = checkEvidence(candidate, second);
    state.state = 'validated';
  } else if (command === 'install') {
    requireThat(state.state === 'validated', 'Candidate is not validated');
    requireThat(checkBuildReceipt(runDirectory, candidate) === state.buildReceiptSha256, 'Build receipt changed since staging');
    requireThat(hash(candidate) === state.candidateSha256 && toolkitHash() === state.acceptance.toolkitSha256, 'Candidate/toolkit changed since validation');
    for (const receipt of Object.values(state.acceptance.receipts)) requireThat(hash(receipt.file) === receipt.sha256, 'Acceptance receipt changed');
    const installed = selectedRuntime(state.installedDirectory);
    checkOfficial(installed);
    checkOfficial(path.join(runDirectory, 'official'));
    checkOfficial(path.dirname(candidate), false);
    assertPlainTree(installed);
    const live = path.join(installed, 'codex.exe');
    const suffix = crypto.randomUUID();
    const backup = live + '.before-local-repair-' + suffix;
    const stage = live + '.staged-' + suffix;
    const receiptFile = path.join(runDirectory, 'install.json');
    const receipt = { state: 'staging', live, backup, stage, originalSha256: hash(live), candidateSha256: hash(candidate) };
    writeNewJson(receiptFile, receipt);
    // Keep both binaries on the same volume. No running process is terminated.
    try {
      fs.copyFileSync(candidate, stage, fs.constants.COPYFILE_EXCL);
      requireThat(hash(stage) === receipt.candidateSha256, 'Staged copy changed');
      fs.renameSync(live, backup);
      receipt.originalRenamed = true;
      replaceJson(receiptFile, receipt);
      requireThat(hash(backup) === receipt.originalSha256, 'Original changed during installation');
      fs.renameSync(stage, live);
      receipt.activated = true;
      requireThat(hash(live) === receipt.candidateSha256, 'Installed hash mismatch');
      receipt.state = 'installed';
      replaceJson(receiptFile, receipt);
    } catch (error) {
      receipt.error = String(error);
      if (receipt.originalRenamed && hash(backup) === receipt.originalSha256) {
        if (fs.existsSync(live)) {
          requireThat(hash(live) === receipt.candidateSha256, 'Refusing rollback over an unrelated changed file');
          fs.renameSync(live, live + '.failed-' + suffix);
        }
        fs.renameSync(backup, live);
        receipt.state = 'rolled-back';
      } else receipt.state = 'failed-before-replacement';
      replaceJson(receiptFile, receipt);
      throw error;
    }
    state.state = 'installed-pending-verification';
  } else if (command === 'verify-installed') {
    requireThat(state.state === 'installed-pending-verification', 'No pending installation');
    const installed = selectedRuntime(state.installedDirectory);
    const live = path.join(installed, 'codex.exe');
    requireThat(hash(live) === state.candidateSha256, 'Installed executable changed');
    checkOfficial(installed, false);
    state.installedAcceptance = checkEvidence(live, second, ['reopened', 'offline']);
    state.state = 'installed-verified-pending-reload';
  } else if (command === 'rollback') {
    requireThat(state.state.startsWith('installed-'), 'No installed repair recorded');
    const installed = selectedRuntime(state.installedDirectory);
    checkOfficial(installed, false);
    const receiptFile = path.join(runDirectory, 'install.json');
    const receipt = readJson(receiptFile);
    const live = path.join(installed, 'codex.exe');
    requireThat(receipt.state === 'installed' && path.resolve(receipt.live) === live && path.dirname(receipt.backup) === installed && path.basename(receipt.backup).startsWith('codex.exe.before-local-repair-'), 'Rollback receipt path mismatch');
    requireThat(hash(live) === state.candidateSha256 && hash(receipt.backup) === version.officialFiles['codex.exe'], 'Rollback hashes changed');
    const retired = live + '.retired-local-repair-' + crypto.randomUUID();
    fs.renameSync(live, retired);
    try { fs.renameSync(receipt.backup, live); } catch (error) { fs.renameSync(retired, live); throw error; }
    receipt.state = 'rolled-back';
    receipt.retired = retired;
    replaceJson(receiptFile, receipt);
    state.state = 'rolled-back';
  }
  state.updated = new Date().toISOString();
  replaceJson(file, state);
  console.log(JSON.stringify({ state: state.state, runDirectory, candidateSha256: state.candidateSha256 }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
