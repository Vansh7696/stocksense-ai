import React from 'react';

const badgeVariants = {
  default: 'bg-fintech-surface text-slate-300 border-fintech-border',
  neutral: 'bg-slate-800/80 text-slate-400 border-slate-700/60',
  bullish: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  bearish: 'bg-rose-500/10 text-rose-400 border-rose-500/25',
  danger: 'bg-rose-500/10 text-rose-400 border-rose-500/25',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  cyan: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/25',
  purple: 'bg-purple-500/10 text-purple-400 border-purple-500/25',
};

const dotColors = {
  default: 'bg-slate-400',
  neutral: 'bg-slate-400',
  bullish: 'bg-emerald-400',
  success: 'bg-emerald-400',
  bearish: 'bg-rose-400',
  danger: 'bg-rose-400',
  warning: 'bg-amber-400',
  info: 'bg-blue-400',
  cyan: 'bg-cyan-400',
  purple: 'bg-purple-400',
};

const badgeSizes = {
  xs: 'text-[10px] px-1.5 py-0.5 gap-1',
  sm: 'text-xs px-2 py-0.5 gap-1.5',
  md: 'text-xs px-2.5 py-1 gap-1.5',
};

export function Badge({
  children,
  variant = 'default',
  size = 'xs',
  dot = false,
  mono = true,
  className = '',
  ...props
}) {
  const variantClass = badgeVariants[variant] || badgeVariants.default;
  const dotClass = dotColors[variant] || dotColors.default;
  const sizeClass = badgeSizes[size] || badgeSizes.xs;
  const fontClass = mono ? 'font-mono' : 'font-sans';

  return (
    <span
      className={`inline-flex items-center font-medium border rounded select-none ${variantClass} ${sizeClass} ${fontClass} ${className}`}
      {...props}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />}
      {children}
    </span>
  );
}

export default Badge;
