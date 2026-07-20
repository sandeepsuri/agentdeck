import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ThemeProvider } from './theme.js';
import './theme.css';
import './workspace.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider><App /></ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
