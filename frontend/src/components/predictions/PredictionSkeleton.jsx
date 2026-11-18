import React from 'react';
import { Card, Skeleton } from '../ui';

/**
 * PredictionSkeleton Component
 * Renders an accessible, shimmering loading placeholder while multi-horizon
 * predictions are computed or retrieved from Redis cache.
 */
export default function PredictionSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading machine learning forecasts">
      {/* Overview Header Skeleton */}
      <Card className="p-5 bg-fintech-surface/80 border-fintech-border/80">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-52 rounded-md" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
            <Skeleton className="h-4 w-72 rounded-md" />
          </div>

          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </Card>

      {/* 3 Multi-Horizon Cards Skeleton Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {[1, 2, 3].map((idx) => (
          <Card key={idx} className="p-5 space-y-4 bg-fintech-surface/60 border-fintech-border/70">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Skeleton className="h-4 w-20 rounded-full" />
                <Skeleton className="h-5 w-32 rounded-md" />
              </div>
              <Skeleton className="h-4 w-14 rounded-md" />
            </div>

            {/* Direction Callout Box */}
            <Skeleton className="h-16 w-full rounded-xl" />

            {/* Movement and Threshold Box */}
            <Skeleton className="h-14 w-full rounded-lg" />

            {/* Probability Distribution Bar */}
            <div className="space-y-2 pt-1">
              <Skeleton className="h-3 w-full rounded-full" />
              <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-8 rounded-md" />
                <Skeleton className="h-8 rounded-md" />
                <Skeleton className="h-8 rounded-md" />
              </div>
            </div>

            {/* Execution Window */}
            <div className="space-y-1.5 pt-2 border-t border-fintech-border/40">
              <Skeleton className="h-3 w-40 rounded" />
              <Skeleton className="h-3 w-36 rounded" />
            </div>

            {/* Footer */}
            <div className="pt-2 border-t border-fintech-border/40">
              <Skeleton className="h-4 w-32 rounded" />
            </div>
          </Card>
        ))}
      </div>

      {/* Disclaimer Skeleton */}
      <Card className="p-4 bg-fintech-surface/40 border-fintech-border/50">
        <Skeleton className="h-12 w-full rounded-lg" />
      </Card>
    </div>
  );
}
