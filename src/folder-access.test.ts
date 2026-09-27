import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderAccess, normalizeAllowedRoots } from './folder-access.js';
import { GrantPathError } from './personal-tasks/folder-grant.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-access-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('folderAccess', () => {
  it('keeps legacy npm start behavior: scans projectsDir and refuses nothing', () => {
    const access = folderAccess({ projectsDir: '/Users/me/Projects' });
    expect(access.roots()).toEqual(['/Users/me/Projects']);
    expect(access.enforced()).toBe(false);
    expect(access.allows('/anywhere')).toBe(true);
  });

  it('allows nothing when the Mac app started it and no folder is chosen yet', () => {
    const access = folderAccess({ projectsDir: '', launchedByApp: true });
    expect(access.roots()).toEqual([]);
    expect(access.allows(os.tmpdir())).toBe(false);
  });

  it('allows paths inside a chosen folder only, not a sibling sharing its prefix or a symlink out', () => {
    const base = tempDir();
    const allowed = path.join(base, 'foo');
    const sibling = path.join(base, 'foobar');
    fs.mkdirSync(path.join(allowed, 'repo'), { recursive: true });
    fs.mkdirSync(sibling);
    fs.symlinkSync(sibling, path.join(allowed, 'escape'));
    const access = folderAccess({ projectsDir: '/legacy', allowedRoots: [allowed] });

    expect(access.roots()).toEqual([allowed]);
    expect(access.allows(allowed)).toBe(true);
    expect(access.allows(path.join(allowed, 'repo'))).toBe(true);
    expect(access.allows(path.join(allowed, 'repo', '..', '..', 'foobar'))).toBe(false);
    expect(access.allows(sibling)).toBe(false);
    expect(access.allows(path.join(allowed, 'escape'))).toBe(false);
  });

  it('allows a worktree of an allowed repo that lives outside the chosen folder', () => {
    const allowed = tempDir();
    const outside = tempDir();
    const repo = { id: path.join(allowed, 'app'), name: 'app', path: path.join(allowed, 'app'), worktrees: [{ path: outside, branch: 'x' }] };
    const access = folderAccess({ projectsDir: '', allowedRoots: [allowed] }, () => [repo]);
    expect(access.allows(outside)).toBe(true);
    const foreign = { ...repo, id: '/elsewhere', path: '/elsewhere' };
    expect(folderAccess({ projectsDir: '', allowedRoots: [allowed] }, () => [foreign]).allows(outside)).toBe(false);
  });
});

describe('normalizeAllowedRoots', () => {
  it('canonicalizes and dedupes, and refuses the home folder and protected folders', () => {
    const home = tempDir();
    const projects = path.join(home, 'Projects');
    const data = path.join(home, '.agentdeck');
    fs.mkdirSync(projects);
    fs.mkdirSync(data);

    expect(normalizeAllowedRoots([projects, `${projects}/`], { homeDir: home })).toEqual([projects]);
    expect(() => normalizeAllowedRoots([home], { homeDir: home })).toThrow(GrantPathError);
    expect(() => normalizeAllowedRoots([data], { homeDir: home, protectedRoots: [data] })).toThrow(GrantPathError);
    expect(() => normalizeAllowedRoots(['relative/path'], { homeDir: home })).toThrow(GrantPathError);
  });
});
