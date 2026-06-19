#!/usr/bin/env node
// scripts/smoke.cjs
//
// Smoke-test rig for the kit's mechanical guarantees: both hooks
// (SessionStart, UserPromptSubmit) and both validators (stage-prompts,
// retrospective). Synthetic fixtures, no network, ~5 seconds.
//
// What this proves:        the mechanism still fires correctly.
// What this does NOT prove: output quality. For that, run a walkthrough.
//
// Usage:
//   node scripts/smoke.cjs
//
// Exits 0 on all-pass, 1 on any failure.
//
// Covers regression scenarios from the v1.1 IRL test:
//   * P#27 — validator must find blocks in CRLF Phase docs (was: 0 silently).
//   * P#29 — hooks must read active-mode as UTF-16LE+BOM and UTF-8+BOM
//           (PowerShell `>` writes UTF-16; failure silently fell back to work).
//   * P#16 — Phase doc >600 lines must warn but NOT fail (exit 0).
//   * P-3 enforcement — mode-mismatch must block, match must pass, ad-hoc
//           must pass, missing active-mode must default to work.
//   * P#15 — retro stamp must be enforced (missing / placeholder / out-of-range
//           all fail; valid passes; divergence emits NOTE without failing).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const SS_HOOK = path.join(KIT_ROOT, 'templates/dot-claude/hooks/session-start-read-first.cjs');
const MC_HOOK = path.join(KIT_ROOT, 'templates/dot-claude/hooks/user-prompt-submit-mode-check.cjs');
const SP_VALIDATOR = path.join(KIT_ROOT, 'validators/validate-stage-prompts.cjs');
const RT_VALIDATOR = path.join(KIT_ROOT, 'validators/validate-retrospective.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-smoke-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

let passed = 0;
let failed = 0;
const failures = [];

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label} ${DIM}(want ${expected}, got ${actual})${RESET}`);
    failed++;
    failures.push(label);
  }
}

function section(title) { console.log(`\n${title}`); }

function runNode(script, args = [], opts = {}) {
  const r = spawnSync('node', [script, ...args], { input: opts.input, encoding: 'utf8', cwd: opts.cwd || TMP });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------- fixtures ----------

const fixtures = path.join(TMP, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });

// Valid Phase doc with a complete work_stage_prompt block (LF).
const VALID_BLOCK = `<work_stage_prompt id="M01.A">
<context>x</context><read_first>y</read_first><scope_locks>z</scope_locks>
<gates>g</gates><retrospective_requirements>r</retrospective_requirements>
<commit_protocol>c</commit_protocol><commit_message>m</commit_message>
<approval_surface>a</approval_surface><deliverable>d</deliverable>
<execution_steps>e</execution_steps><test_plan_required>t</test_plan_required>
<acceptance_criteria>ac</acceptance_criteria>
</work_stage_prompt>`;
const lfDoc = path.join(fixtures, 'docs', 'build-prompts', 'M01-lf.md');
fs.mkdirSync(path.dirname(lfDoc), { recursive: true });
fs.writeFileSync(lfDoc, `# M01\n\n\`\`\`xml\n${VALID_BLOCK}\n\`\`\`\n`);

// Same block but CRLF — the P#27 regression case.
const crlfDoc = path.join(fixtures, 'docs', 'build-prompts', 'M01-crlf.md');
fs.writeFileSync(crlfDoc, `# M01\r\n\r\n\`\`\`xml\r\n${VALID_BLOCK.replace(/\n/g, '\r\n')}\r\n\`\`\`\r\n`);

// >600 line Phase doc with one valid block — P#16 regression.
const bigDoc = path.join(fixtures, 'docs', 'build-prompts', 'M01-big.md');
const bigLines = Array.from({ length: 700 }, (_, i) => `filler line ${i + 1}`).join('\n');
fs.writeFileSync(bigDoc, `# M01\n\n${bigLines}\n\n\`\`\`xml\n${VALID_BLOCK}\n\`\`\`\n`);

// Phase doc with the block but missing a required tag (gates) — should fail.
const brokenDoc = path.join(fixtures, 'docs', 'build-prompts', 'M01-broken.md');
fs.writeFileSync(brokenDoc, `# M01\n\n\`\`\`xml\n${VALID_BLOCK.replace('<gates>g</gates>', '')}\n\`\`\`\n`);

// Retrospective fixtures.
function retroFile(name, body) {
  const p = path.join(fixtures, `${name}-retrospective.md`);
  fs.writeFileSync(p, body);
  return p;
}
const retroValid = retroFile('valid', '```user-stamp\nscore: 4\nnote: smooth\n```\n');
const retroMissing = retroFile('missing', '## end\nno stamp here\n');
const retroPlaceholder = retroFile('placeholder', '```user-stamp\nscore: {{1-5}}\nnote: real\n```\n');
const retroBadScore = retroFile('badscore', '```user-stamp\nscore: 9\nnote: real\n```\n');
const retroDivergent = retroFile(
  'divergent',
  '**Score: 5**\n**Score: 5**\n**Score: 5**\n```user-stamp\nscore: 2\nnote: ui broken\n```\n'
);

// Mode-file fixtures across encodings (the P#29 regressions).
function writeMode(buf) {
  const dir = path.join(TMP, 'modecheck', '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-mode'), buf);
  return path.dirname(dir); // cwd for the hook
}
const ENC_PLAIN = Buffer.from('verifier\n', 'utf8');
const ENC_UTF16LE_BOM = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('verifier\r\n', 'utf16le')]); // PowerShell `>`
const ENC_UTF8_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('verifier\n', 'utf8')]);

// ---------- 1. validate-stage-prompts.cjs ----------

section('validate-stage-prompts.cjs');

let r = runNode(SP_VALIDATOR, ['--templates'], { cwd: KIT_ROOT });
check('kit templates validate clean (exit 0)', r.code, 0);

r = runNode(SP_VALIDATOR, [lfDoc]);
check('LF Phase doc with valid block (exit 0)', r.code, 0);

// P#27 — CRLF must still find the block.
r = runNode(SP_VALIDATOR, ['--allow-placeholders', crlfDoc]);
check('CRLF Phase doc finds blocks [P#27 regression] (exit 0)', r.code, 0);
check('  ...and reports 1 block', /1 block(s)? across/.test(r.stdout), true);

// P#16 — >600 lines warns, doesn't fail.
r = runNode(SP_VALIDATOR, [bigDoc]);
check('>600 line Phase doc exits 0 [P#16 regression]', r.code, 0);
check('  ...and emits a `warning:` line', /^warning:/m.test(r.stderr || r.stdout), true);

r = runNode(SP_VALIDATOR, [brokenDoc]);
check('Phase doc with missing required tag fails (exit 1)', r.code, 1);

// ---------- 2. validate-retrospective.cjs ----------

section('validate-retrospective.cjs');

r = runNode(RT_VALIDATOR, [retroValid]);
check('valid stamp passes (exit 0)', r.code, 0);

r = runNode(RT_VALIDATOR, [retroMissing]);
check('missing stamp block fails (exit 1)', r.code, 1);

r = runNode(RT_VALIDATOR, [retroPlaceholder]);
check('placeholder {{1-5}} fails (exit 1)', r.code, 1);

r = runNode(RT_VALIDATOR, [retroBadScore]);
check('out-of-range score fails (exit 1)', r.code, 1);

r = runNode(RT_VALIDATOR, [retroDivergent]);
check('divergence (|Δ|≥2) exits 0 (advisory, not failure)', r.code, 0);
check('  ...and emits a `NOTE` line', /^NOTE/m.test(r.stderr || r.stdout), true);

// ---------- 3. UserPromptSubmit mode-check across encodings ----------

section('user-prompt-submit-mode-check.cjs');

function modeCheck(mode_bytes, prompt) {
  const cwd = writeMode(mode_bytes);
  return runNode(MC_HOOK, [], { cwd, input: JSON.stringify({ prompt }) });
}

const WORK_PROMPT = '<work_stage_prompt id="M01.A"><context>x</context></work_stage_prompt>';
const VERIFY_PROMPT = '<verifier_stage_prompt></verifier_stage_prompt>';
const ADHOC = 'what model are you running on?';

// active-mode = verifier (each encoding) × work prompt → BLOCK (exit 2)
check('plain UTF-8:    verifier session + work prompt BLOCKS', modeCheck(ENC_PLAIN, WORK_PROMPT).code, 2);
check('UTF-16LE+BOM:   verifier session + work prompt BLOCKS [P#29 regression]', modeCheck(ENC_UTF16LE_BOM, WORK_PROMPT).code, 2);
check('UTF-8+BOM:      verifier session + work prompt BLOCKS', modeCheck(ENC_UTF8_BOM, WORK_PROMPT).code, 2);

// matching mode passes
check('plain UTF-8:    verifier session + verifier prompt PASSES', modeCheck(ENC_PLAIN, VERIFY_PROMPT).code, 0);
check('UTF-16LE+BOM:   verifier session + verifier prompt PASSES', modeCheck(ENC_UTF16LE_BOM, VERIFY_PROMPT).code, 0);

// ad-hoc prompt (no stage tag) → always pass
check('ad-hoc prompt (no <mode>, no stage tag) PASSES', modeCheck(ENC_PLAIN, ADHOC).code, 0);

// missing active-mode → defaults to work
const noModeDir = path.join(TMP, 'nomode');
fs.mkdirSync(path.join(noModeDir, '.claude'), { recursive: true });
let r2 = runNode(MC_HOOK, [], { cwd: noModeDir, input: JSON.stringify({ prompt: WORK_PROMPT }) });
check('missing active-mode defaults to work; work prompt PASSES', r2.code, 0);
r2 = runNode(MC_HOOK, [], { cwd: noModeDir, input: JSON.stringify({ prompt: VERIFY_PROMPT }) });
check('missing active-mode defaults to work; verifier prompt BLOCKS', r2.code, 2);

// malformed stdin → falls back to raw
r2 = runNode(MC_HOOK, [], { cwd: writeMode(ENC_PLAIN), input: WORK_PROMPT });
check('malformed (non-JSON) stdin falls back to raw and BLOCKS', r2.code, 2);

// ---------- 4. SessionStart hook (synthetic project + each mode encoding) ----------

section('session-start-read-first.cjs');

function ssRun(modeBytes) {
  const proj = path.join(TMP, 'ssproj');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  // Minimal read-first list + a target file. project-config.md absent → default cap=8 (medium).
  fs.writeFileSync(path.join(proj, '.claude/read-first-list.txt'), 'CLAUDE.md\n');
  fs.writeFileSync(path.join(proj, '.claude/read-first-list-verifier.txt'), 'CLAUDE.md\n');
  fs.writeFileSync(path.join(proj, '.claude/read-first-list-orchestrator.txt'), 'CLAUDE.md\n');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'project rules\n');
  if (modeBytes !== null) fs.writeFileSync(path.join(proj, '.claude/active-mode'), modeBytes);
  return runNode(SS_HOOK, [], { cwd: proj });
}

let s = ssRun(null);
check('no active-mode → stamp shows mode=work', /\[read-first stamp\]\*{0,2}\s+mode=work/.test(s.stdout), true);

s = ssRun(ENC_PLAIN);
check('plain UTF-8 verifier → stamp shows mode=verifier', /\[read-first stamp\]\*{0,2}\s+mode=verifier/.test(s.stdout), true);

s = ssRun(ENC_UTF16LE_BOM);
check('UTF-16LE+BOM verifier → stamp shows mode=verifier [P#29 regression]', /\[read-first stamp\]\*{0,2}\s+mode=verifier/.test(s.stdout), true);

s = ssRun(ENC_UTF8_BOM);
check('UTF-8+BOM verifier → stamp shows mode=verifier', /\[read-first stamp\]\*{0,2}\s+mode=verifier/.test(s.stdout), true);

// ---------- summary ----------

console.log();
if (failed === 0) {
  console.log(`${GREEN}all ${passed} smoke checks passed.${RESET}`);
  console.log(`${DIM}this proves the mechanism — for output quality, run a walkthrough.${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${failed} of ${passed + failed} smoke checks FAILED${RESET}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
