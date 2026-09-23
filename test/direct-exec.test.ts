import { describe, expect, it } from 'vitest';
import { directExecArgv } from '../src/main/codex/direct-exec.js';

const env = { PATH: 'C:\\Tools;C:\\Git\\cmd' };
const resolve = (name: string) => {
  const base = name.toLowerCase().replace(/\.exe$/, '');
  return ['git', 'gh', 'node', 'python', 'python3', 'rg', 'ripgrep'].includes(base) ? `C:\\Bin\\${base}.exe` : null;
};

describe('stateless direct exec fast path', () => {
  it('bypasses PowerShell for a simple allowlisted native command', () => {
    expect(directExecArgv('git status --short', 'powershell', env, 'win32', resolve)).toEqual([
      'C:\\Bin\\git.exe', 'status', '--short'
    ]);
  });
  it('preserves simple quoted argv without evaluating shell text', () => {
    expect(directExecArgv("git log --grep 'hello world'", 'powershell', env, 'win32', resolve)).toEqual([
      'C:\\Bin\\git.exe', 'log', '--grep', 'hello world'
    ]);
    expect(directExecArgv('node -e "console.log(123)"', 'powershell', env, 'win32', resolve)).toEqual([
      'C:\\Bin\\node.exe', '-e', 'console.log(123)'
    ]);
  });
  it('refuses every command whose meaning depends on PowerShell', () => {
    for (const command of [
      'git status; git diff', 'git status | Out-String', 'git status > out.txt',
      'git "$env:HOME"', 'Write-Output hi', 'curl https://example.com',
      'git status # comment', 'git log -- *.ts', 'git status && git diff'
    ]) expect(directExecArgv(command, 'powershell', env, 'win32', resolve), command).toBeNull();
  });
  it('never bypasses an explicit non-PowerShell platform/shell contract', () => {
    expect(directExecArgv('git status', 'bash', env, 'win32', resolve)).toBeNull();
    expect(directExecArgv('git status', 'powershell', env, 'linux', resolve)).toBeNull();
  });
});
