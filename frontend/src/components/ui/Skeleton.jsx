import React from 'react';

export function Skeleton({ className = '', ...props }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-800/60 border border-slate-700/20 ${className}`}
      {...props}
    />
  );
}

export function StatCardSkeleton() {
  return (
    <div className="p-4 sm:p-5 rounded-xl bg-fintech-card border border-fintech-border space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-6 w-6 rounded-md" />
      </div>
      <Skeleton className="h-7 w-32" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}

export function IndexCardSkeleton() {
  return (
    <div className="p-4 rounded-xl bg-fintech-card border border-fintech-border space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-12 rounded" />
      </div>
      <div className="space-y-1.5 pt-1">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-3.5 w-20" />
      </div>
      <div className="pt-2 border-t border-fintech-border/60 flex justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

export function TableRowSkeleton({ columns = 5 }) {
  return (
    <tr className="border-b border-fintech-border/50">
      {Array.from({ length: columns }).map((_, idx) => (
        <td key={idx} className="px-4 py-3">
          <Skeleton className="h-4 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

export default Skeleton;
