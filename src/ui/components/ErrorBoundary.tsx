import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agentdeck] UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return <main style={{ background: 'var(--canvas)', color: 'var(--text-primary)', minHeight: '100vh', padding: 32, fontFamily: '"Instrument Sans", system-ui, sans-serif' }}><h1>AgentDeck encountered an error</h1><pre>{this.state.error.message}</pre><button onClick={() => location.reload()}>Reload</button></main>;
    return this.props.children;
  }
}
