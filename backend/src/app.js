import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import healthRoutes from './routes/health.routes.js';
import upstoxOAuthRoutes from './routes/upstoxOAuth.routes.js';
import authRoutes from './routes/auth.routes.js';
import adminRoutes from './routes/admin.routes.js';
import stockRoutes from './routes/stock.routes.js';
import marketRoutes from './routes/market.routes.js';
import watchlistRoutes from './routes/watchlist.routes.js';
import alertRoutes from './routes/alert.routes.js';
import { errorHandler, AppError } from './middleware/errorHandler.js';
import { getWhitelistedOrigins } from './middleware/csrf.js';
import { bigIntJsonReplacer } from './utils/json.js';
import { redactString } from './utils/crypto.js';

const app = express();

if (config.env === 'production') {
  app.set('trust proxy', 1);
}

// Configure Express JSON serialization to explicitly serialize BigInt as decimal strings
app.set('json replacer', bigIntJsonReplacer);

// Security and utility middleware
app.use(helmet({
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = getWhitelistedOrigins();
    if (allowed.has(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Sanitize query parameters in HTTP logs to prevent credentials, code, or state from leaking
morgan.token('clean-url', (req) => redactString(req.originalUrl || req.url));

if (config.env !== 'test') {
  app.use(morgan(':method :clean-url :status :res[content-length] - :response-time ms'));
}

// Health check endpoint
app.use('/api', healthRoutes);

// Upstox OAuth 2.0 authentication endpoints
app.use('/api/auth/upstox', upstoxOAuthRoutes);

// StockSense application user authentication endpoints
app.use('/api/auth', authRoutes);

// Administrative management endpoints (protected by requireAuth)
app.use('/api/admin', adminRoutes);

// Stock catalogue & historical price endpoints
app.use('/api/stocks', stockRoutes);

// Market overview & indices endpoints
app.use('/api/market', marketRoutes);

// User watchlists endpoints (protected by requireAuth)
app.use('/api/watchlists', watchlistRoutes);

// User stock alerts endpoints (protected by requireAuth)
app.use('/api/alerts', alertRoutes);

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'StockSense AI Backend API Gateway',
    version: '1.0.0',
    documentation: '/api/docs',
    health: '/api/health'
  });
});

// 404 Handler for undefined routes
app.use((req, res, next) => {
  next(new AppError(`Endpoint not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
});

// Centralized error handling middleware
app.use(errorHandler);

export default app;
