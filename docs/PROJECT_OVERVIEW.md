# StockSense AI — Project Overview

## 1. Executive Summary
**StockSense AI** is a financial intelligence and explainable decision-support platform tailored for Indian equity markets (NSE and BSE). Rather than offering black-box price predictions, the platform synthesizes technical indicators, corporate fundamentals, news sentiment analytics, and machine learning models to generate transparent and accountable recommendations (**BUY**, **HOLD**, **SELL**, or **NO SIGNAL**).

## 2. Target Market
- **Equities**: National Stock Exchange of India (NSE) & Bombay Stock Exchange (BSE).
- **Indices Tracked**: NIFTY 50, SENSEX, NIFTY Bank, NIFTY IT, NIFTY Smallcap/Midcap.
- **Horizon**: 1–5 trading day swing and position horizon.

## 3. Core Value Propositions
1. **Explainability**: Every recommendation includes SHAP feature attribution and technical factor contributions.
2. **Data Integrity**: Clean segregation between historical, delayed, mock, and real-time feeds. Strict avoidance of look-ahead bias and data leakage.
3. **Modular Market Data Integration**: Pluggable provider architecture with initial support for Upstox API V3, extensible to Angel One SmartAPI and other brokers.
4. **Institutional Grade UX**: Dark fintech interface featuring TradingView charts, real-time indicators, and clear signals.

## 4. Technology Stack Justification
- **React.js + Tailwind CSS + TradingView Lightweight Charts**: Highly responsive, canvas-accelerated charting with low memory footprint.
- **Node.js + Express.js**: Asynchronous I/O ideal for API gateways, stream proxying, and caching layer orchestration.
- **PostgreSQL + Prisma ORM (v6)**: ACID compliance, type-safe schema modeling, explicit decimal precision for financial transactions and volume tracking.
- **Redis**: High-throughput distributed cache to respect market API rate limits and reduce redundant database hits.
- **FastAPI + PyTorch / Scikit-Learn / XGBoost**: High-performance asynchronous Python microservice for heavy vectorized calculations and ML model inference.
