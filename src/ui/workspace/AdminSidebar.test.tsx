import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Repo } from '../../types.js';
import { AdminSidebar } from './AdminSidebar.js';

const repos: Repo[] = [
  { id: 'repo-agentdeck', path: '/repos/agentdeck', name: 'AgentDeck' },
  { id: 'repo-website', path: '/repos/website', name: 'Website' },
];

function render(overrides: Partial<Parameters<typeof AdminSidebar>[0]> = {}) {
  return renderToStaticMarkup(createElement(AdminSidebar, {
    activeView: 'home', activeRepositoryId: null, needsYouCount: 0, reviewCount: 0, repos,
    repositoryActivity: new Map(), onSelectRepository: () => undefined, onSettings: () => undefined,
    onStartWork: () => undefined, onView: () => undefined,
    ...overrides,
  }));
}

describe('AdminSidebar', () => {
  it('contains only Home, Work, Review, Usage and Settings as primary destinations', () => {
    const html = render();
    const navigation = html.slice(html.indexOf('aria-label="Admin navigation"'), html.indexOf('aria-label="Repositories"'));
    for (const label of ['Home', 'Work', 'Review', 'Usage']) expect(navigation).toContain(`<span>${label}</span>`);
    for (const retired of ['Operations', 'Sessions', 'Grid', 'History', 'Signals', 'Tasks', 'Changes', 'Overview']) {
      expect(html).not.toContain(retired);
    }
    expect(html).toContain('<strong>Settings</strong>');
    expect(html).toContain('<strong>Start work</strong>');
    expect(html).not.toContain('New run');
    expect(html).not.toContain('New session');
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
  });
});
