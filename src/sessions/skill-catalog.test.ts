import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillCatalog, readFrontMatter } from './skill-catalog.js';

let root: string;
let home: string;
let project: string;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-skills-'));
  home = path.join(root, 'claude-home');
  project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readFrontMatter', () => {
  it('reads plain and quoted values and returns the body', () => {
    expect(readFrontMatter('---\nname: tdd\ndescription: "Red, green: refactor"\n---\n# Body')).toEqual({
      fields: { name: 'tdd', description: 'Red, green: refactor' },
      body: '# Body',
    });
    expect(readFrontMatter('no front-matter')).toEqual({ fields: {}, body: 'no front-matter' });
  });
});

describe('SkillCatalog', () => {
  it('lists user skills, commands, nested commands and plugin skills', () => {
    write(path.join(home, 'skills', 'implement', 'SKILL.md'), '---\nname: implement\ndescription: Build a ticket end to end\n---\nSteps');
    write(path.join(home, 'skills', 'bare', 'SKILL.md'), '# Does a bare thing\n\nMore text');
    write(path.join(home, 'skills', 'not-a-skill', 'README.md'), 'ignored');
    write(path.join(home, 'commands', 'ship.md'), '---\ndescription: Push and open a PR\n---\nbody');
    write(path.join(home, 'commands', 'git', 'tidy.md'), 'Tidy the branch');
    const pluginRoot = path.join(home, 'plugins', 'cache', 'official', 'frontend-design', '1');
    write(path.join(pluginRoot, 'skills', 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: Design pages\n---\n');
    write(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'frontend-design@official': [{ scope: 'user', installPath: pluginRoot }],
        'off@official': [{ scope: 'user', installPath: pluginRoot }],
      },
    }));
    write(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@official': false } }));

    expect(new SkillCatalog({ claudeHome: home }).list(project)).toEqual([
      { name: 'bare', description: 'Does a bare thing', source: 'user', kind: 'skill' },
      { name: 'frontend-design:frontend-design', description: 'Design pages', source: 'plugin', kind: 'skill' },
      { name: 'git:tidy', description: 'Tidy the branch', source: 'user', kind: 'command' },
      { name: 'implement', description: 'Build a ticket end to end', source: 'user', kind: 'skill' },
      { name: 'ship', description: 'Push and open a PR', source: 'user', kind: 'command' },
    ]);
  });

  it('prefers a project skill over a user one of the same name and follows symlinked skill folders', () => {
    write(path.join(home, 'skills', 'implement', 'SKILL.md'), '---\ndescription: user version\n---\n');
    write(path.join(project, '.agents', 'skills', 'implement', 'SKILL.md'), '---\ndescription: project version\n---\n');
    fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync('../../.agents/skills/implement', path.join(project, '.claude', 'skills', 'implement'));

    expect(new SkillCatalog({ claudeHome: home }).list(project)).toEqual([
      { name: 'implement', description: 'project version', source: 'project', kind: 'skill' },
    ]);
  });

  it('returns nothing when no config exists and caches briefly', () => {
    let now = 0;
    const catalog = new SkillCatalog({ claudeHome: home, now: () => now });
    expect(catalog.list(project)).toEqual([]);
    write(path.join(home, 'skills', 'new', 'SKILL.md'), 'New skill');
    expect(catalog.list(project)).toEqual([]);
    now = 11_000;
    expect(catalog.list(project).map((skill) => skill.name)).toEqual(['new']);
  });
});
