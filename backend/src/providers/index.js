import upstoxProviderInstance, { UpstoxProvider } from './upstox/UpstoxProvider.js';
import { MarketDataProvider } from './MarketDataProvider.js';
import upstoxClientInstance, { UpstoxClient } from './upstox/upstox.client.js';
import {
  UPSTOX_ENDPOINTS,
  UPSTOX_UNITS,
  INTERVAL_TO_V3_MAP,
} from './upstox/upstox.constants.js';
import {
  encodeInstrumentKey,
  resolveInstrumentKey,
  mapQuoteResponse,
  mapLtpResponse,
  VERIFIED_SEED_INSTRUMENTS,
  VERIFIED_INSTRUMENTS_METADATA,
} from './upstox/upstox.mapper.js';
import {
  serializeMarketData,
  toDecimalSafeString,
  safeJsonStringify,
  bigIntJsonReplacer,
} from '../services/marketDataValidator.service.js';

// Primary provider export for the application
export const marketDataProvider = upstoxProviderInstance;

export {
  MarketDataProvider,
  UpstoxProvider,
  UpstoxClient,
  upstoxClientInstance as upstoxClient,
  UPSTOX_ENDPOINTS,
  UPSTOX_UNITS,
  INTERVAL_TO_V3_MAP,
  encodeInstrumentKey,
  resolveInstrumentKey,
  mapQuoteResponse,
  mapLtpResponse,
  VERIFIED_SEED_INSTRUMENTS,
  VERIFIED_INSTRUMENTS_METADATA,
  serializeMarketData,
  toDecimalSafeString,
  safeJsonStringify,
  bigIntJsonReplacer,
};

export default marketDataProvider;
