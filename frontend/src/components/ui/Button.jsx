import React from 'react';
import { Loader2 } from 'lucide-react';

const variants = {
  primary:
    'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white shadow-sm shadow-blue-500/20 border border-blue-500/30',
  secondary:
    'bg-fintech-surface hover:bg-slate-800 text-slate-200 border border-fintech-border hover:border-slate-700 active:bg-slate-700',
  outline:
    'bg-transparent hover:bg-fintech-surface/80 text-slate-300 hover:text-white border border-fintech-border active:border-slate-600',
  ghost:
    'bg-transparent hover:bg-fintech-surface/60 text-slate-400 hover:text-slate-200 border border-transparent',
  danger:
    'bg-rose-600/15 hover:bg-rose-600/25 text-rose-400 border border-rose-500/30 active:bg-rose-600/35',
  success:
    'bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400 border border-emerald-500/30 active:bg-emerald-600/35',
};

const sizes = {
  xs: 'px-2 py-1 text-xs gap-1.5 rounded',
  sm: 'px-3 py-1.5 text-xs gap-1.5 rounded-md font-medium',
  md: 'px-4 py-2 text-sm gap-2 rounded-lg font-medium',
  lg: 'px-5 py-2.5 text-base gap-2.5 rounded-lg font-medium',
};

export const Button = React.forwardRef(function Button(
  {
    children,
    variant = 'secondary',
    size = 'sm',
    className = '',
    disabled = false,
    loading = false,
    icon: Icon,
    iconPosition = 'left',
    type = 'button',
    ...props
  },
  ref
) {
  const baseClasses =
    'inline-flex items-center justify-center font-sans tracking-tight transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50 disabled:pointer-events-none select-none';
  const variantClasses = variants[variant] || variants.secondary;
  const sizeClasses = sizes[size] || sizes.sm;

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`${baseClasses} ${variantClasses} ${sizeClasses} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-current" />
      ) : Icon && iconPosition === 'left' ? (
        <Icon className="w-3.5 h-3.5 shrink-0" />
      ) : null}
      {children}
      {!loading && Icon && iconPosition === 'right' ? (
        <Icon className="w-3.5 h-3.5 shrink-0" />
      ) : null}
    </button>
  );
});

export default Button;
