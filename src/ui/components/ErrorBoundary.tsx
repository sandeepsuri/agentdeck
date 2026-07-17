import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agentdeck] UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) return <main style={{ background: '#090d12', color: '#f0f6fc', minHeight: '100vh', padding: 32, fontFamily: 'system-ui' }}><h1>AgentDeck encountered an error</h1><pre>{this.state.error.message}</pre><button onClick={() => location.reload()}>Reload</button></main>;
    return this.props.children;
  }
}
