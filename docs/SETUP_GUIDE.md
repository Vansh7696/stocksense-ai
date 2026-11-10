# StockSense AI — Developer Setup Guide

This guide describes how to run and verify the StockSense AI platform locally on macOS, Linux, or Windows.

## Prerequisites
1. **Node.js**: v18.0.0 or higher (`node -v`)
2. **Python**: v3.10 or higher (`python3 --version`)
3. **PostgreSQL**: v14 or higher (or Docker)
4. **Redis**: v6 or higher (or Docker)

---

## 1. Quick Docker Setup
To launch the full stack (PostgreSQL, Redis, Backend, ML service, and Frontend):
```bash
docker compose up -d
```
Services will become available at:
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:5001`
- ML Service: `http://localhost:8000`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

---

## 2. Manual Local Development Setup

### Backend (Node.js & Express)
1. Navigate to backend directory:
   ```bash
   cd backend
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```
3. Copy environment configuration:
   ```bash
   cp ../.env.example .env
   ```
4. Run Prisma database migrations and seed script:
   ```bash
   npx prisma migrate dev --name init
   npx prisma db seed
   ```
5. Start development server:
   ```bash
   npm run dev
   ```

### ML Microservice (FastAPI & Python)
1. Navigate to ML service directory:
   ```bash
   cd ml-service
   ```
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Start FastAPI server:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

### Frontend (React & Vite)
1. Navigate to frontend directory:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start Vite dev server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:5173` in your browser.
