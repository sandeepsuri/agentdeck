// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repo } from '../../types.js';
import { EXPANDED_REPOSITORIES_STORAGE_KEY } from '../preferences.js';
import type { WorkItem } from '../workItems.js';
import { AdminSidebar } from './AdminSidebar.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

const repos: Repo[] = [
  { id: 'repo-agentdeck', path: '/repos/agentdeck', name: 'AgentDeck' },
  { id: 'repo-website', path: '/repos/website', name: 'Website' },
];

function render(overrides: Partial<Parameters<typeof AdminSidebar>[0]> = {}) {
  return renderToStaticMarkup(createElement(AdminSidebar, {
    activeView: 'home', activeRepositoryId: null, needsYouCount: 0, reviewCount: 0, repos,
    repositoryActivity: new Map(), onSelectRepository: () => undefined, onSettings: () => undefined,
    onStartWork: () => undefined, onView: () => undefined, onOpenWorkItem: () => undefined,
    workItems: [], selectedWorkItemId: null,
    ...overrides,
  }));
}

function chat(id: string, repositoryId: string, bucket: WorkItem['bucket'], title = `Chat ${id}`): WorkItem {
  return {
    id: `session:${id}`, kind: 'session', title, agent: 'claude', agentLabel: 'Claude',
    repositoryId, repositoryName: repositoryId, bucket, statusLabel: bucket, tone: 'neutral',
    startedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function mount(overrides: Partial<Parameters<typeof AdminSidebar>[0]> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(AdminSidebar, {
    activeView: 'work', activeRepositoryId: null, needsYouCount: 0, reviewCount: 0, repos,
    repositoryActivity: new Map(), onSelectRepository: () => undefined, onSettings: () => undefined,
    onStartWork: () => undefined, onView: () => undefined, onOpenWorkItem: () => undefined,
    workItems: [], selectedWorkItemId: null,
    ...overrides,
  })));
  return container;
}

describe('AdminSidebar', () => {
  it('leads with the everyday Home and groups developer destinations under Developer tools', () => {
    const html = render();
    const navigation = html.slice(html.indexOf('aria-label="Admin navigation"'), html.indexOf('aria-label="Repositories"'));
    const developerAt = navigation.indexOf('Developer tools');
    expect(developerAt).toBeGreaterThan(navigation.indexOf('<span>Home</span>'));
    for (const label of ['Overview', 'Work', 'Review', 'Usage']) expect(navigation.indexOf(`<span>${label}</span>`)).toBeGreaterThan(developerAt);
    expect(navigation).toContain('role="group" aria-label="Developer tools"');
    for (const retired of ['Operations', 'Sessions', 'Grid', 'History', 'Signals', 'Tasks', 'Changes']) {
      expect(html).not.toContain(retired);
    }
    expect(html).toContain('<strong>Settings</strong>');
    expect(html).toContain('<strong>Start work</strong>');
    expect(html).not.toContain('New run');
    expect(html).not.toContain('New session');
  });

  it('lists Personal tasks beside Home, outside Developer tools (#80)', () => {
    const html = render();
    const navigation = html.slice(html.indexOf('aria-label="Admin navigation"'), html.indexOf('aria-label="Repositories"'));
    const personalAt = navigation.indexOf('<span>Personal tasks</span>');
    expect(personalAt).toBeGreaterThan(navigation.indexOf('<span>Home</span>'));
    expect(personalAt).toBeLessThan(navigation.indexOf('Developer tools'));
  });

  it('marks the open developer destination as the current page', () => {
    const html = render({ activeView: 'overview' });
    expect(html).toMatch(/aria-current="page"[^>]*title="Overview"/);
  });

  it('mirrors the Needs You and review counts as badges', () => {
    const html = render({ needsYouCount: 3, reviewCount: 2 });
    expect(html).toContain('aria-label="3 items need you"');
    expect(html).toContain('aria-label="2 ready for review"');
    expect(render()).not.toContain('need you');
  });

  it('lists repositories as contextual shortcuts with active and waiting counts', () => {
    const html = render({
      activeRepositoryId: 'repo-agentdeck',
      repositoryActivity: new Map([['repo-agentdeck', { active: 2, waiting: 1 }]]),
    });
    expect(html).toContain('AgentDeck');
    expect(html).toContain('Website');
    expect(html).toContain('aria-label="2 active, 1 waiting"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="sidebar-repo is-working"');
  });

  it('marks a repository whose only active work is waiting on you as waiting, not working', () => {
    const html = render({ repositoryActivity: new Map([['repo-agentdeck', { active: 1, waiting: 1 }]]) });
    expect(html).toContain('class="sidebar-repo is-waiting"');
    expect(html).not.toContain('is-working');
  });

  it('outlines the active repository and shows the working wave only while an agent is running, not just waiting', () => {
    const host = mount({
      activeRepositoryId: 'repo-agentdeck',
      repositoryActivity: new Map([['repo-agentdeck', { active: 2, waiting: 0 }], ['repo-website', { active: 1, waiting: 1 }]]),
    });
    const [agentdeck, website] = [...host.querySelectorAll('.sidebar-repo-row')];
    expect(agentdeck!.classList.contains('is-active')).toBe(true);
    expect(agentdeck!.querySelector('.sidebar-repo-activity')).not.toBeNull();
    expect(website!.classList.contains('is-active')).toBe(false);
    expect(website!.querySelector('.sidebar-repo-activity')).toBeNull();
  });

  it('nests non-archived chats under repositories with work in flight, marking status and selection', () => {
    const html = render({
      repositoryActivity: new Map([['repo-agentdeck', { active: 2, waiting: 1 }]]),
      selectedWorkItemId: 'session:b',
      workItems: [
        chat('a', 'repo-agentdeck', 'working', 'Redesign sidebar repo chats'),
        chat('b', 'repo-agentdeck', 'needs_you'),
        chat('c', 'repo-agentdeck', 'completed'),
        chat('old', 'repo-agentdeck', 'archived', 'Archived chat'),
        chat('w', 'repo-website', 'completed', 'Website chat'),
        { ...chat('f', 'repo-agentdeck', 'completed', 'Failed chat'), tone: 'error' },
      ],
    });
    expect(html).toContain('aria-label="Chats in AgentDeck"');
    expect(html).toContain('title="Redesign sidebar repo chats"');
    expect(html).not.toContain('Archived chat');
    expect(html).toMatch(/aria-current="true" class="sidebar-chat is-selected"[^>]*title="Chat b"/);
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('aria-label="Needs you"');
    expect(html).toMatch(/aria-label="Failed" class="sidebar-chat-dot is-error"/);
    // Website has no work in flight, so it starts collapsed but still lists.
    expect(html).toContain('aria-label="Expand Website"');
    expect(html).not.toContain('Website chat');
  });

  it('keeps the active count on a collapsed repository', () => {
    window.localStorage.setItem(EXPANDED_REPOSITORIES_STORAGE_KEY, '[]');
    const html = render({
      repositoryActivity: new Map([['repo-agentdeck', { active: 1, waiting: 0 }]]),
      workItems: [chat('a', 'repo-agentdeck', 'working')],
    });
    expect(html).toContain('aria-label="Expand AgentDeck"');
    expect(html).not.toContain('Chats in AgentDeck');
    expect(html).toContain('aria-label="1 active"');
  });

  it('caps the chats per repository and links the rest to Work', () => {
    const onSelectRepository = vi.fn();
    const items = Array.from({ length: 7 }, (_, index) => chat(String(index), 'repo-agentdeck', 'completed'));
    const node = mount({ activeRepositoryId: 'repo-agentdeck', workItems: items, onSelectRepository });
    expect(node.querySelectorAll('.sidebar-chat:not(.sidebar-chat-more)')).toHaveLength(5);
    const more = node.querySelector<HTMLButtonElement>('.sidebar-chat-more');
    expect(more?.textContent).toBe('Show 2 more');
    act(() => more?.click());
    expect(onSelectRepository).toHaveBeenCalledWith('repo-agentdeck');
  });

  it('opens a chat through the shared work-item path and remembers expansion', () => {
    const onOpenWorkItem = vi.fn();
    const item = chat('w', 'repo-website', 'working', 'Website chat');
    const node = mount({ workItems: [item], onOpenWorkItem });
    const toggle = node.querySelector<HTMLButtonElement>('[aria-label="Expand Website"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(EXPANDED_REPOSITORIES_STORAGE_KEY) ?? 'null')).toEqual(['repo-website']);
    act(() => node.querySelector<HTMLButtonElement>('[title="Website chat"]')?.click());
    expect(onOpenWorkItem).toHaveBeenCalledWith(item);
  });
});
