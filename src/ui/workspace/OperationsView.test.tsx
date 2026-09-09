import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperationsView } from './OperationsView.js';

describe('OperationsView discovery access', () => {
  it('keeps terminal discovery available where Sessions are browsed', () => {
    const html = renderToStaticMarkup(createElement(OperationsView, {
      conflicts: [], discoveryStatus: {
        running: true, polling: false, scannedProcesses: 0, managedPids: 0,
        detectedProcesses: 0, publishedSessions: 0,
      }, events: [],
      onOpenTerminal: () => undefined, onRefreshDiscovery: () => undefined, onSelect: () => undefined,
      repos: [], selected: null, sessions: [],
    }));
    expect(html).toContain('Rescan terminals');
  });
});
