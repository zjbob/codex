import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, toolkitHash, writeNewJson, checkEvidence, assertPlainTree, version, requiredCases, assertOutside, checkBuildReceipt } from './runtime.mjs';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-test-'));
  try { fn(root); } finally {
    assert.equal(fs.realpathSync(root).toLowerCase(), path.resolve(root).toLowerCase());
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
  }
}
function receipts(root) {
  const binary = path.join(root, 'codex.exe');
  fs.writeFileSync(binary, 'synthetic executable identity');
  const common = { passed: true, binary, binarySha256: hash(binary), toolkitSha256: toolkitHash(), exit: 0, timedOut: false };
  for (const variant of ['base', 'reopened', 'offline', 'linked']) {
    writeNewJson(path.join(root, variant + '.json'), { ...common, variant, networkEnabled: ['reopened', 'linked'].includes(variant), cases: requiredCases.map(item => ({ ...item, passed: true })), protectedUnchanged: true, outsideUnchanged: true, ordinaryRemoved: true, ownRemoved: true });
  }
  writeNewJson(path.join(root, 'startup.json'), { ...common, initialized: true, sqliteError: false, codexHomeOverride: false, models: [version.expectedModel] });
  return binary;
}
function change(file, values) { fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...values })); }

test('complete evidence is bound to exact binary bytes and toolkit', () => fixture(root => {
  const binary = receipts(root);
  assert.equal(Object.keys(checkEvidence(binary, root).receipts).length, 5);
  fs.appendFileSync(binary, 'changed');
  assert.throws(() => checkEvidence(binary, root), /Stale acceptance/);
}));
test('containment failure, wrong network policy, or incomplete cases cannot pass', () => {
  for (const values of [{ outsideUnchanged: false }, { networkEnabled: true }, { cases: [] }]) fixture(root => {
    const binary = receipts(root);
    change(path.join(root, 'offline.json'), values);
    assert.throws(() => checkEvidence(binary, root));
  });
});
test('startup with an isolated home cannot certify real-home compatibility', () => fixture(root => {
  const binary = receipts(root);
  change(path.join(root, 'startup.json'), { codexHomeOverride: true });
  assert.throws(() => checkEvidence(binary, root), /Normal-home/);
}));
test('old toolkit receipts and a different executable path are rejected', () => {
  for (const values of [{ toolkitSha256: 'old' }, { binary: 'missing.exe' }]) fixture(root => {
    const binary = receipts(root);
    change(path.join(root, 'base.json'), values);
    assert.throws(() => checkEvidence(binary, root));
  });
});
test('evidence cannot silently overwrite an earlier result', () => fixture(root => {
  const file = path.join(root, 'result.json');
  writeNewJson(file, { original: true });
  assert.throws(() => writeNewJson(file, { original: false }), /EEXIST/);
}));
test('runtime copy refuses a junction before following it', () => fixture(root => {
  const ordinary = path.join(root, 'ordinary'); fs.mkdirSync(ordinary);
  const tree = path.join(root, 'tree'); fs.mkdirSync(tree);
  const link = path.join(tree, 'escape');
  fs.symlinkSync(ordinary, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => assertPlainTree(tree), /Reparse/); }
  finally { fs.unlinkSync(link); }
}));
test('arbitrary successes or a reversed expected outcome cannot certify acceptance', () => {
  for (const cases of [Array.from({ length: requiredCases.length }, (_, index) => ({ name: String(index), passed: true })), requiredCases.map(item => ({ ...item, expected: 'allowed', passed: true }))]) fixture(root => {
    const binary = receipts(root);
    change(path.join(root, 'reopened.json'), { cases });
    assert.throws(() => checkEvidence(binary, root), /acceptance matrix/);
  });
});
test('filesystem-only success cannot hide an absent or failed Node profile check', () => {
  for (const missing of [true, false]) fixture(root => {
    const binary = receipts(root);
    const file = path.join(root, 'reopened.json');
    const receipt = JSON.parse(fs.readFileSync(file));
    const cases = missing ? receipt.cases.filter(item => item.name !== 'node-user-info')
      : receipt.cases.map(item => ({ ...item, passed: item.name !== 'node-user-info' }));
    change(file, { cases });
    assert.throws(() => checkEvidence(binary, root), /acceptance matrix/);
  });
});

test('run directory rejects dotted children and junction aliases before creation', () => fixture(root => {
  const installed = path.join(root, 'installed'); fs.mkdirSync(installed);
  for (const child of ['..evidence', 'normal/deeper']) {
    const candidate = path.join(installed, child);
    assert.throws(() => assertOutside(installed, candidate), /outside/);
    assert.equal(fs.existsSync(candidate), false);
  }
  assert.doesNotThrow(() => assertOutside(installed, path.join(root, 'sibling')));
  const link = path.join(root, 'alias'); fs.symlinkSync(installed, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => assertOutside(installed, path.join(link, 'child')), /outside/); }
  finally { fs.unlinkSync(link); }
}));
test('staging rejects absent, mismatched, or changed build provenance', () => fixture(root => {
  const binary = path.join(root, 'codex.exe'); fs.writeFileSync(binary, 'build output');
  assert.throws(() => checkBuildReceipt(root, binary), /ENOENT/);
  const file = path.join(root, 'build.json');
  const receipt = { sourceCommit: version.fixCommit, fixCommit: version.fixCommit, sourceTag: version.sourceTag, rust: 'rustc ' + version.rustVersion + ' (test)', binary, binarySha256: hash(binary) };
  writeNewJson(file, receipt);
  assert.equal(checkBuildReceipt(root, binary, true), hash(file));
  for (const values of [{ fixCommit: 'wrong' }, { rust: 'wrong' }, { binarySha256: 'wrong' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...receipt, ...values }));
    assert.throws(() => checkBuildReceipt(root, binary));
  }
}));
