import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import Button from './Button';

export function ErrorState({
  title = 'Failed to load data',
  message = 'An unexpected error occurred while communicating with the service.',
  code,
  onRetry,
  compact = false,
  className = '',
}) {
  if (compact) {
    return (
      <div
        className={`p-3 rounded-lg bg-rose-500/10 border border-rose-500/25 flex items-center justify-between text-xs text-rose-300 gap-3 ${className}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="truncate">{message}</span>
        </div>
        {onRetry && (
          <Button variant="danger" size="xs" onClick={onRetry} icon={RefreshCw}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`p-6 sm:p-8 rounded-xl bg-rose-500/5 border border-rose-500/20 text-center flex flex-col items-center justify-center space-y-3 ${className}`}
    >
      <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
        <AlertCircle className="w-5 h-5" />
      </div>

      <div className="space-y-1 max-w-md">
        <h4 className="text-sm font-semibold text-rose-200">{title}</h4>
        <p className="text-xs text-rose-300/80 leading-relaxed">{message}</p>
        {code && (
          <p className="text-[10px] font-mono text-rose-400/70 pt-0.5">
            Error Code: {code}
          </p>
        )}
      </div>

      {onRetry && (
        <div className="pt-2">
          <Button variant="danger" size="sm" onClick={onRetry} icon={RefreshCw}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}

export default ErrorState;
