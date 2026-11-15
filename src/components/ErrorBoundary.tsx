import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  scope?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'Unexpected rendering error',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    fetch('/api/telemetry/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `[${this.props.scope || 'Workspace'}] ${error.message}`,
        componentStack: errorInfo.componentStack,
      }),
    }).catch(() => {});
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="my-6 rounded-xl border border-red-500/30 bg-slate-900/80 p-6 text-slate-100 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
            <div className="space-y-1">
              <h3 className="font-display text-base font-semibold text-white">
                Fault Isolated by {this.props.scope || 'Application'} Error Boundary
              </h3>
              <p className="text-xs text-slate-300">
                The exception was captured and logged to the Pino telemetry stream without interrupting other workspace services.
              </p>
              {this.state.errorMessage && (
                <pre className="mt-2 rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-red-300 whitespace-pre-wrap">
                  {this.state.errorMessage}
                </pre>
              )}
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset View &amp; Recover
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
