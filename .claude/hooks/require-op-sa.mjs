// Claude Code PreToolUse hook: 1Password reads go through op-sa, never plain op.
// op-sa runs op as the project's service account (~/.config/op-sa/profiles), so there
// is no Touch ID prompt from the 1Password desktop app. Plain op stays allowed for what
// a read-only service account cannot do: creating/editing/deleting items, documents and
// vaults, plus sign-in, help and version.
//
// Install in a project (template: ~/Dev/Projects/agent-config/templates/claude-hooks/):
//   1. Copy this file to <project>/.claude/hooks/require-op-sa.mjs
//   2. Add to <project>/.claude/settings.json under hooks.PreToolUse:
//      { "matcher": "Bash", "hooks": [{ "type": "command",
//        "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/require-op-sa.mjs\"" }] }
//   3. Map the project: op-sa profile add <name> --dir <project>
//
// Best-effort: it parses the Bash command text, so a script that spawns op itself is not seen.
import { readFileSync } from 'node:fs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
if (input.tool_name !== 'Bash') process.exit(0);

// Heredoc bodies are data (file contents, scripts piped to another tool), not shell commands.
const command = String(input.tool_input?.command || '').replace(
  /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g,
  '',
);

// Writes the read-only service account cannot do, and harmless meta commands.
const ALLOWED = [
  /^(item|document|vault)\s+(create|edit|delete|move|share)\b/,
  /^(signin|signout|account|plugin|update|completion)\b/,
  /^(-v|--version|-h|--help)\s*$/,
  /^$/,
];

// Split into simple commands on shell separators and substitutions.
const segments = command.split(/\|\||&&|[;|&\n`]|\$\(|\(|\)/);

for (const raw of segments) {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  // Skip leading env assignments and wrappers: FOO=bar, env, command, exec, sudo, time, xargs.
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || /^(env|command|exec|sudo|time|xargs|nohup)$/.test(words[0]))) {
    words.shift();
  }
  if (!words.length) continue;
  const bin = words[0].replace(/^["']|["']$/g, '');
  if (bin !== 'op' && !bin.endsWith('/op')) continue;

  // Drop global flags (e.g. --account x, --format json) before the subcommand.
  const rest = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (rest.length === 0 && /^--(account|format|config|session|encoding)$/.test(w)) { i++; continue; }
    if (rest.length === 0 && /^--(account|format|config|session|encoding)=/.test(w)) continue;
    if (rest.length === 0 && /^--(cache|debug|no-color|iso-timestamps)\b/.test(w)) continue;
    rest.push(w);
  }
  const sub = rest.join(' ');
  if (ALLOWED.some((re) => re.test(sub))) continue;

  process.stderr.write([
    `Blocked: plain \`op ${sub}\` asks the user for Touch ID in the 1Password desktop app.`,
    'Run it through the service account instead: replace `op` with `op-sa`',
    `(e.g. \`op-sa ${sub}\`). op-sa uses this project's profile and does not prompt.`,
    'Only writes (item/document/vault create, edit, delete) need plain op, because the service account is read-only.',
  ].join('\n') + '\n');
  process.exit(2);
}

process.exit(0);
