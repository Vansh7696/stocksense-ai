import React from 'react';

const paddings = {
  none: '',
  sm: 'p-3 sm:p-4',
  md: 'p-4 sm:p-5',
  lg: 'p-5 sm:p-6',
};

export function Card({
  children,
  title,
  subtitle,
  icon: Icon,
  action,
  footer,
  padding = 'md',
  hoverable = false,
  className = '',
  headerClassName = '',
  bodyClassName = '',
  ...props
}) {
  const paddingClass = paddings[padding] || paddings.md;
  const hoverClass = hoverable
    ? 'hover:border-slate-700/80 hover:shadow-md hover:shadow-black/20 transition-all duration-200'
    : '';

  return (
    <div
      className={`bg-fintech-card border border-fintech-border rounded-xl text-slate-100 overflow-hidden relative ${hoverClass} ${className}`}
      {...props}
    >
      {(title || subtitle || action || Icon) && (
        <div
          className={`flex items-start justify-between border-b border-fintech-border/70 px-4 py-3 sm:px-5 sm:py-3.5 gap-3 ${headerClassName}`}
        >
          <div className="flex items-start gap-2.5 min-w-0">
            {Icon && (
              <div className="w-8 h-8 rounded-lg bg-fintech-surface border border-fintech-border flex items-center justify-center text-blue-400 shrink-0 mt-0.5">
                <Icon className="w-4 h-4" />
              </div>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="text-sm font-semibold text-white tracking-tight truncate">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="text-xs text-fintech-muted truncate mt-0.5">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}

      <div className={`${paddingClass} ${bodyClassName}`}>{children}</div>

      {footer && (
        <div className="border-t border-fintech-border/60 bg-fintech-surface/30 px-4 py-2.5 sm:px-5 text-xs text-slate-400">
          {footer}
        </div>
      )}
    </div>
  );
}

export default Card;
