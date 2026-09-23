/**
 * Conservative shell-bypass fast path for short developer commands on Windows.
 *
 * The ordinary exec path deliberately executes text through the user's shell. Starting Windows
 * PowerShell costs a few hundred milliseconds even when the requested native program finishes in
 * tens of milliseconds. For a tiny set of developer executables whose command line contains no
 * shell semantics, we can preserve the same argv while skipping only that shell startup.
 *
 * This is intentionally an allowlist, not a shell parser. Any ambiguity falls back to the normal
 * PowerShell path. In particular: no pipes/redirection/statements, no variable expansion, no
 * profiles/login shells, no .cmd/.bat/.ps1 wrappers and no aliases such as PowerShell's `curl`.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ShellType } from './shell.js';

const DIRECT_PROGRAMS = new Set(['git', 'gh', 'node', 'python', 'python3', 'rg', 'ripgrep']);

interface ParsedToken { value: string; quoted: boolean; }

type Resolver = (program: string, env: NodeJS.ProcessEnv) => string | null;

function file(candidate: string): string | null {
  try { return statSync(candidate).isFile() ? candidate : null; } catch { return null; }
}

/** PATH lookup restricted to real .exe files. PowerShell script/cmd wrappers are not equivalent. */
export function resolveDirectExecutable(program: string, env: NodeJS.ProcessEnv): string | null {
  const tail = program.toLowerCase();
  const base = tail.endsWith('.exe') ? tail.slice(0, -4) : tail;
  if (!DIRECT_PROGRAMS.has(base) || (!/^[a-z0-9._-]+$/i.test(program))) return null;
  const names = tail.endsWith('.exe') ? [program] : [`${program}.exe`];
  const raw = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of raw.split(';')) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean) continue;
    for (const name of names) {
      const candidate = path.join(clean, name);
      if (existsSync(candidate) && file(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Small PowerShell-native argv reader. It accepts only syntax where bypassing PowerShell cannot
 * change meaning. A token is either entirely unquoted or entirely single/double quoted; mixed
 * quoting, interpolation and every top-level operator abstain rather than guess.
 */
function parseSimplePowerShell(command: string): ParsedToken[] | null {
  if (!command.trim() || /[\r\n]/.test(command)) return null;
  const tokens: ParsedToken[] = [];
  let index = 0;
  const skipSpace = (): void => { while (index < command.length && /[ \t]/.test(command[index]!)) index++; };
  skipSpace();
  while (index < command.length) {
    const start = command[index]!;
    if (start === '"' || start === "'") {
      const quote = start;
      index++;
      let value = '';
      let closed = false;
      while (index < command.length) {
        const char = command[index]!;
        if (char === quote) {
          // PowerShell single-quoted strings spell one literal apostrophe as ''.
          if (quote === "'" && command[index + 1] === "'") { value += "'"; index += 2; continue; }
          closed = true; index++; break;
        }
        // Double-quoted PowerShell strings interpolate `$` and use backtick escapes. Those need
        // the real shell. Single quotes are literal, so both characters are harmless there.
        if (quote === '"' && (char === '$' || char === '`')) return null;
        value += char; index++;
      }
      if (!closed) return null;
      if (index < command.length && !/[ \t]/.test(command[index]!)) return null;
      tokens.push({ value, quoted: true });
    } else {
      let value = '';
      while (index < command.length && !/[ \t]/.test(command[index]!)) {
        const char = command[index]!;
        // Everything here has shell-level meaning or can change native argv under PowerShell.
        if (';|&<>$`(){}#*?'.includes(char) || char === '"' || char === "'") return null;
        value += char; index++;
      }
      if (!value) return null;
      tokens.push({ value, quoted: false });
    }
    skipSpace();
  }
  return tokens.length ? tokens : null;
}

function directProgramName(candidate: string): string | null {
  const tail = candidate.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const base = tail.endsWith('.exe') ? tail.slice(0, -4) : tail;
  return DIRECT_PROGRAMS.has(base) ? base : null;
}

/**
 * Returns the native argv that is provably equivalent to this simple PowerShell command, else
 * null. `& 'C:\\...\\rg.exe' ...` is accepted only for an absolute allowlisted .exe; this is the
 * deterministic form produced by bindBundledRipgrep.
 */
export function directExecArgv(
  command: string,
  shellType: ShellType,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  resolve: Resolver = resolveDirectExecutable
): string[] | null {
  if (platform !== 'win32' || shellType !== 'powershell') return null;
  const parsed = parseSimplePowerShell(command);
  if (!parsed) {
    // The one shell operator we deliberately accept is PowerShell's call operator in front of a
    // literal absolute executable. Parse it separately without making `&` generally eligible.
    const match = /^\s*&\s+('[^'\r\n]*(?:''[^'\r\n]*)*'|"[^"$`\r\n]*")(?:\s+([\s\S]*))?\s*$/.exec(command);
    if (!match) return null;
    const quoted = parseSimplePowerShell(match[1]!);
    if (!quoted || quoted.length !== 1) return null;
    const executable = quoted[0]!.value;
    if (!path.win32.isAbsolute(executable) || path.win32.extname(executable).toLowerCase() !== '.exe' || !directProgramName(executable)) return null;
    if (!file(executable)) return null;
    const rest = match[2]?.trim() ? parseSimplePowerShell(match[2]!) : [];
    if (rest === null) return null;
    return [executable, ...rest.map(token => token.value)];
  }

  const [program, ...args] = parsed;
  if (!program || program.quoted || /[\\/]/.test(program.value)) return null;
  if (!directProgramName(program.value)) return null;
  const executable = resolve(program.value, env);
  if (!executable || path.extname(executable).toLowerCase() !== '.exe') return null;
  return [executable, ...args.map(token => token.value)];
}
