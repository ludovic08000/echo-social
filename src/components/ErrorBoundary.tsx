import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { captureCrash, getLastCrash, type CrashContext } from '@/lib/crashLogger';
import { CrashDetails } from '@/components/CrashDetails';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /** When this key changes (e.g. route pathname), the boundary auto-resets. */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
  crash?: CrashContext | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    const crash = captureCrash({
      message: error.message || 'react.boundary',
      source: 'react.boundary',
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    }) ?? getLastCrash();
    this.setState({ crash });
  }

  componentDidUpdate(prevProps: Props) {
    // Auto-reset when navigating to a new route — avoids "stuck" boundary after navigation.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  handleRetry = () => {
    // First try a soft reset; if the error was a stale lazy chunk it will re-throw on next render
    // and the user can hit "Recharger la page" below. We expose both options to avoid surprise reloads.
    this.setState({ hasError: false, error: undefined });
  };

  handleHardReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-7 h-7 text-destructive" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground mb-1">Quelque chose s'est mal passé</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Une erreur inattendue est survenue. Essayez de réessayer, ou rechargez la page si le problème persiste.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={this.handleRetry}
              className="gap-2 rounded-xl"
            >
              <RefreshCw className="w-4 h-4" />
              Réessayer
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={this.handleHardReload}
              className="gap-2 rounded-xl"
            >
              Recharger la page
            </Button>
          </div>
          {(this.state.crash ?? getLastCrash()) && (
            <CrashDetails crash={(this.state.crash ?? getLastCrash())!} />
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
