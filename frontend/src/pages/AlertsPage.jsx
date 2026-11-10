import React, { useState, useEffect, useCallback } from 'react';
import {
  Bell,
  Plus,
  Trash2,
  TrendingUp,
  TrendingDown,
  Percent,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Edit2,
  Check,
  X,
  Info,
} from 'lucide-react';
import {
  getAlertsApi,
  createAlertApi,
  updateAlertApi,
  deleteAlertApi,
  searchStocks,
} from '../services/api';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';

const ALERT_TYPES = [
  { value: 'PRICE_ABOVE', label: 'Price Rises Above (₹)', icon: TrendingUp },
  { value: 'PRICE_BELOW', label: 'Price Drops Below (₹)', icon: TrendingDown },
  { value: 'PCT_CHANGE_UP', label: 'Day Gain Exceeds (%)', icon: Percent },
  { value: 'PCT_CHANGE_DOWN', label: 'Day Drop Exceeds (%)', icon: Percent },
];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Form modal/collapsible states
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [symbolInput, setSymbolInput] = useState('');
  const [selectedStock, setSelectedStock] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [alertType, setAlertType] = useState('PRICE_ABOVE');
  const [targetValue, setTargetValue] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState(null);

  // Inline editing state: { alertId: string, value: string }
  const [editingAlertId, setEditingAlertId] = useState(null);
  const [editingValue, setEditingValue] = useState('');

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAlertsApi();
      setAlerts(res?.data?.alerts || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to retrieve stock alerts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  // Stock search for alert creation
  useEffect(() => {
    if (!symbolInput.trim() || selectedStock) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await searchStocks(symbolInput.trim(), 5);
        setSearchResults(res?.data?.results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [symbolInput, selectedStock]);

  const handleCreateAlert = async (e) => {
    e.preventDefault();
    setFormError(null);

    if (!selectedStock && !symbolInput.trim()) {
      setFormError('Please select a valid equity stock.');
      return;
    }

    const val = parseFloat(targetValue);
    if (isNaN(val) || val <= 0) {
      setFormError('Target value must be a positive number.');
      return;
    }

    setActionLoading(true);
    try {
      const payload = {
        alertType,
        targetValue: val,
        notes: notes.trim() || undefined,
      };

      if (selectedStock?.id) {
        payload.stockId = selectedStock.id;
      } else {
        payload.symbol = symbolInput.trim().toUpperCase();
      }

      await createAlertApi(payload);

      // Reset form
      setShowCreateForm(false);
      setSelectedStock(null);
      setSymbolInput('');
      setTargetValue('');
      setNotes('');
      await fetchAlerts();
    } catch (err) {
      setFormError(err.message || 'Failed to create stock alert.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async (alert) => {
    try {
      await updateAlertApi(alert.id, { isActive: !alert.isActive });
      setAlerts((prev) =>
        prev.map((a) => (a.id === alert.id ? { ...a, isActive: !a.isActive } : a))
      );
    } catch (err) {
      setError(err.message || 'Failed to toggle alert status.');
    }
  };

  const handleSaveEdit = async (alertId) => {
    const val = parseFloat(editingValue);
    if (isNaN(val) || val <= 0) {
      setError('Target value must be a positive number.');
      return;
    }

    try {
      await updateAlertApi(alertId, { targetValue: val });
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, targetValue: val } : a))
      );
      setEditingAlertId(null);
      setEditingValue('');
    } catch (err) {
      setError(err.message || 'Failed to update alert target.');
    }
  };

  const handleDeleteAlert = async (alertId) => {
    if (!window.confirm('Are you sure you want to delete this alert rule?')) return;
    try {
      await deleteAlertApi(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      setError(err.message || 'Failed to delete alert.');
    }
  };

  const formatAlertTypeLabel = (type) => {
    switch (type) {
      case 'PRICE_ABOVE':
        return 'Price Above';
      case 'PRICE_BELOW':
        return 'Price Below';
      case 'PCT_CHANGE_UP':
        return 'Gain Exceeds';
      case 'PCT_CHANGE_DOWN':
        return 'Drop Exceeds';
      default:
        return type;
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* ------------------------------------------------------------- */}
      {/* Header & Title Section                                         */}
      {/* ------------------------------------------------------------- */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-fintech-border/80 gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
              <Bell className="w-6 h-6 text-blue-400" />
              <span>Stock Price Alerts</span>
            </h1>
            <Badge variant="blue" size="sm" dot>
              PERSISTENT RULES
            </Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Configure price threshold and percentage change triggers for Indian equities
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setShowCreateForm((prev) => !prev);
            setFormError(null);
          }}
          className="flex items-center gap-1.5 font-mono text-xs"
        >
          {showCreateForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          <span>{showCreateForm ? 'Cancel' : 'New Alert'}</span>
        </Button>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Roadmap Phase Notice                                          */}
      {/* ------------------------------------------------------------- */}
      <div className="p-4 rounded-xl bg-fintech-card border border-blue-500/20 flex items-start gap-3">
        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed text-slate-300">
          <span className="font-semibold text-white">Rule Persistence Active: </span>
          Alert configurations are securely persisted in PostgreSQL. Real-time background trade
          evaluation and automated push/email notifications will activate in Phase 5.
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Create Alert Form                                             */}
      {/* ------------------------------------------------------------- */}
      {showCreateForm && (
        <div className="p-5 sm:p-6 rounded-2xl bg-fintech-card border border-fintech-border shadow-2xl space-y-4">
          <h2 className="text-sm font-bold text-white font-mono flex items-center gap-2">
            <Plus className="w-4 h-4 text-blue-400" />
            <span>CONFIGURE EQUITY PRICE TRIGGER</span>
          </h2>

          {formError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <form onSubmit={handleCreateAlert} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Stock Search Input */}
            <div className="space-y-1.5 relative">
              <label className="block text-xs font-mono text-slate-300">Target Equity</label>
              <input
                type="text"
                value={selectedStock ? `${selectedStock.symbol} — ${selectedStock.companyName || ''}` : symbolInput}
                onChange={(e) => {
                  setSelectedStock(null);
                  setSymbolInput(e.target.value);
                }}
                placeholder="Search symbol (e.g. RELIANCE, TCS)..."
                className="w-full bg-fintech-surface border border-fintech-border rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
              />
              {selectedStock && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStock(null);
                    setSymbolInput('');
                  }}
                  className="absolute right-3 top-8 text-slate-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Autocomplete Dropdown */}
              {searchResults.length > 0 && !selectedStock && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-fintech-card border border-fintech-border rounded-xl shadow-2xl z-30 max-h-48 overflow-y-auto divide-y divide-fintech-border/30">
                  {searchResults.map((item) => (
                    <button
                      key={item.id || item.symbol}
                      type="button"
                      onClick={() => {
                        setSelectedStock(item);
                        setSymbolInput(item.symbol);
                        setSearchResults([]);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-fintech-surface flex items-center justify-between text-xs font-mono text-slate-200"
                    >
                      <span className="font-semibold text-white">{item.symbol}</span>
                      <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                        {item.companyName}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Alert Condition Selector */}
            <div className="space-y-1.5">
              <label className="block text-xs font-mono text-slate-300">Trigger Condition</label>
              <select
                value={alertType}
                onChange={(e) => setAlertType(e.target.value)}
                className="w-full bg-fintech-surface border border-fintech-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
              >
                {ALERT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Target Value Input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-mono text-slate-300">
                Target Threshold Value ({alertType.includes('PCT') ? '%' : '₹'})
              </label>
              <input
                type="number"
                step="0.05"
                min="0.01"
                required
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder={alertType.includes('PCT') ? '5.0' : '3150.00'}
                className="w-full bg-fintech-surface border border-fintech-border rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            {/* Notes Input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-mono text-slate-300">Notes (Optional)</label>
              <input
                type="text"
                maxLength={255}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Breakout resistance level..."
                className="w-full bg-fintech-surface border border-fintech-border rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div className="md:col-span-2 pt-2 flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowCreateForm(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={actionLoading}
                className="flex items-center gap-1.5"
              >
                {actionLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Save Alert Rule</span>
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* Alert Rules List                                              */}
      {/* ------------------------------------------------------------- */}
      <div className="bg-fintech-card border border-fintech-border rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-fintech-border/80 flex items-center justify-between bg-fintech-surface/40">
          <span className="font-mono text-xs font-semibold text-slate-200">
            ACTIVE RULES ({alerts.length})
          </span>
        </div>

        {loading ? (
          <div className="p-12 text-center space-y-3 font-mono text-xs text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500 mx-auto" />
            <p>Loading active stock alerts...</p>
          </div>
        ) : alerts.length === 0 ? (
          <div className="py-16 text-center space-y-4">
            <div className="w-12 h-12 rounded-xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-500">
              <Bell className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">No active stock alerts</p>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto font-mono">
                Click &quot;New Alert&quot; to define price limits and gain/loss triggers.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono text-xs">
              <thead>
                <tr className="border-b border-fintech-border/60 text-[11px] text-slate-400 uppercase tracking-wider bg-fintech-surface/20">
                  <th className="py-3 px-4 sm:px-6">Stock</th>
                  <th className="py-3 px-4">Condition</th>
                  <th className="py-3 px-4">Target Value</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4">Notes</th>
                  <th className="py-3 px-4 sm:px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fintech-border/40">
                {alerts.map((alert) => {
                  const isEditing = editingAlertId === alert.id;
                  const isPct = alert.alertType?.includes('PCT');
                  const unit = isPct ? '%' : '₹';

                  return (
                    <tr
                      key={alert.id}
                      className="hover:bg-fintech-surface/60 transition-colors"
                    >
                      {/* Stock Symbol */}
                      <td className="py-3.5 px-4 sm:px-6">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white text-xs">
                            {alert.stock?.symbol || 'STOCK'}
                          </span>
                          <span className="text-[10px] px-1 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                            {alert.stock?.exchange?.code || 'NSE'}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate max-w-xs font-sans mt-0.5">
                          {alert.stock?.companyName}
                        </p>
                      </td>

                      {/* Condition */}
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {formatAlertTypeLabel(alert.alertType)}
                        </span>
                      </td>

                      {/* Target Value (with inline edit) */}
                      <td className="py-3.5 px-4 font-semibold text-white">
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              step="0.05"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              className="w-24 bg-fintech-surface border border-blue-500 rounded px-2 py-1 text-xs text-white"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(alert.id)}
                              className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingAlertId(null)}
                              className="p-1 rounded text-slate-400 hover:bg-slate-700"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span>
                              {unit} {parseFloat(alert.targetValue).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingAlertId(alert.id);
                                setEditingValue(String(alert.targetValue));
                              }}
                              className="text-slate-500 hover:text-slate-300"
                              title="Edit target value"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Active Status Toggle */}
                      <td className="py-3.5 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(alert)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-colors ${
                            alert.isActive
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              alert.isActive ? 'bg-emerald-400' : 'bg-slate-500'
                            }`}
                          />
                          <span>{alert.isActive ? 'ACTIVE' : 'PAUSED'}</span>
                        </button>
                      </td>

                      {/* Notes */}
                      <td className="py-3.5 px-4 text-slate-400 text-[11px] truncate max-w-xs font-sans">
                        {alert.notes || '—'}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 sm:px-6 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteAlert(alert.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Delete alert"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
