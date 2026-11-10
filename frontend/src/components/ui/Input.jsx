import React from 'react';

export const Input = React.forwardRef(function Input(
  {
    label,
    error,
    helperText,
    icon: Icon,
    trailingIcon: TrailingIcon,
    onTrailingIconClick,
    mono = false,
    className = '',
    containerClassName = '',
    disabled = false,
    id,
    ...props
  },
  ref
) {
  const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-xs font-medium text-slate-300 tracking-tight"
        >
          {label}
        </label>
      )}

      <div className="relative flex items-center">
        {Icon && (
          <div className="absolute left-3 text-slate-500 pointer-events-none flex items-center justify-center">
            <Icon className="w-4 h-4" />
          </div>
        )}

        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          className={`w-full bg-fintech-surface border rounded-lg text-xs text-slate-100 placeholder-slate-500 transition-all duration-150 focus:outline-none focus:ring-1 ${
            mono ? 'font-mono' : 'font-sans'
          } ${Icon ? 'pl-9' : 'pl-3.5'} ${TrailingIcon ? 'pr-9' : 'pr-3.5'} py-2 ${
            error
              ? 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/40 text-rose-200'
              : 'border-fintech-border hover:border-slate-700 focus:border-blue-500/70 focus:ring-blue-500/30'
          } ${disabled ? 'opacity-50 cursor-not-allowed bg-slate-900/60' : ''} ${className}`}
          {...props}
        />

        {TrailingIcon && (
          <button
            type="button"
            onClick={onTrailingIconClick}
            disabled={!onTrailingIconClick || disabled}
            className={`absolute right-3 flex items-center justify-center text-slate-400 ${
              onTrailingIconClick ? 'hover:text-slate-200 cursor-pointer' : 'pointer-events-none'
            }`}
          >
            <TrailingIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {error ? (
        <p className="text-[11px] text-rose-400 font-medium tracking-tight">{error}</p>
      ) : helperText ? (
        <p className="text-[11px] text-slate-500">{helperText}</p>
      ) : null}
    </div>
  );
});

export default Input;
