import React from 'react';
import { Inbox } from 'lucide-react';
import Button from './Button';

export function EmptyState({
  icon: Icon = Inbox,
  title = 'No records found',
  description = 'No data is currently available for this section.',
  actionLabel,
  onAction,
  className = '',
}) {
  return (
    <div
      className={`p-8 sm:p-12 text-center rounded-xl bg-fintech-surface/30 border border-dashed border-fintech-border flex flex-col items-center justify-center space-y-3 ${className}`}
    >
      <div className="w-11 h-11 rounded-xl bg-fintech-surface border border-fintech-border flex items-center justify-center text-slate-400">
        <Icon className="w-5 h-5" />
      </div>
      <div className="space-y-1 max-w-sm">
        <h4 className="text-sm font-semibold text-slate-200">{title}</h4>
        <p className="text-xs text-fintech-muted leading-relaxed">{description}</p>
      </div>
      {actionLabel && onAction && (
        <div className="pt-2">
          <Button variant="secondary" size="xs" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export default EmptyState;
