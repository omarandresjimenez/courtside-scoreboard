import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors anywhere below it and shows them on
 * screen instead of leaving a blank page — the umpire and TV screens run
 * unattended on devices with no dev console. index.html's inline
 * window.onerror handler is the companion to this: it catches what this
 * can't, like the module bundle failing to load at all on an old browser.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Courtside Scoreboard crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <main className="screen-message">
          <div>
            <h1>Something went wrong</h1>
            <p className="field-error">{error.message}</p>
            <p>Reload this page to try again.</p>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
