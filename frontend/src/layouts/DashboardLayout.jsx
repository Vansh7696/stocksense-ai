import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/common/Sidebar';
import Header from '../components/common/Header';
import { getMarketOverview } from '../services/api';

export default function DashboardLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [providerStatus, setProviderStatus] = useState(null);

  useEffect(() => {
    async function fetchPlatformStatus() {
      try {
        const response = await getMarketOverview();
        if (response?.data?.provider) {
          setProviderStatus(response.data.provider);
        }
      } catch {
        // Soft fail; status defaults to offline/pending
      }
    }
    fetchPlatformStatus();
  }, []);

  return (
    <div className="flex min-h-screen bg-fintech-dark text-slate-100 font-sans selection:bg-blue-600/30 selection:text-white">
      {/* Sidebar with Mobile Drawer support */}
      <Sidebar
        isOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        providerStatus={providerStatus}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with hamburger toggle and dynamic status */}
        <Header
          onOpenMobileNav={() => setMobileNavOpen(true)}
          providerStatus={providerStatus}
        />

        {/* Main View Area */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto max-w-7xl w-full mx-auto">
          <Outlet context={{ providerStatus }} />
        </main>
      </div>
    </div>
  );
}
