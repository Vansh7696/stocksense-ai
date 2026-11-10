import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Compass, ArrowLeft, LayoutDashboard, Search } from 'lucide-react';
import { Card, Button } from '../components/ui';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4">
      <Card className="max-w-lg w-full p-8 text-center bg-fintech-card border border-fintech-border shadow-2xl space-y-5">
        <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto">
          <Compass className="w-8 h-8 animate-pulse" />
        </div>

        <div className="space-y-2">
          <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
            HTTP 404
          </span>
          <h1 className="text-2xl font-bold font-mono text-white tracking-tight">
            Page Not Found
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed max-w-sm mx-auto">
            The requested destination route does not exist on the StockSense AI platform or may have been relocated.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate('/')}
            className="gap-2 font-mono text-xs"
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span>Dashboard</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/stocks')}
            className="gap-2 font-mono text-xs"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Stock Explorer</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(-1)}
            className="gap-1.5 font-mono text-xs"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Go Back</span>
          </Button>
        </div>

        <div className="pt-4 border-t border-fintech-border/40 text-[11px] font-mono text-slate-500">
          StockSense AI Indian Equities Intelligence (NSE / BSE)
        </div>
      </Card>
    </div>
  );
}
