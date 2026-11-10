/**
 * StockSense AI — Database Seeder (NSE & BSE Equities)
 * Idempotent seeder populating verified Indian equity exchanges and blue-chip equities.
 * Strict Rule: Never inject fabricated prices, volumes, or simulated financial ratios.
 */
import prisma from '../src/config/prisma.js';

export const verifiedExchanges = [
  {
    code: 'NSE',
    name: 'National Stock Exchange of India',
    country: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  },
  {
    code: 'BSE',
    name: 'BSE Limited',
    country: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  },
];

export const verifiedStocks = [
  {
    exchangeCode: 'NSE',
    symbol: 'RELIANCE',
    companyName: 'Reliance Industries Limited',
    isin: 'INE002A01018',
    instrumentToken: 'NSE_EQ|INE002A01018',
    series: 'EQ',
    sector: 'Energy',
    industry: 'Oil & Gas - Refining & Marketing',
  },
  {
    exchangeCode: 'NSE',
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services Limited',
    isin: 'INE467B01029',
    instrumentToken: 'NSE_EQ|INE467B01029',
    series: 'EQ',
    sector: 'Information Technology',
    industry: 'IT Services & Consulting',
  },
  {
    exchangeCode: 'NSE',
    symbol: 'INFY',
    companyName: 'Infosys Limited',
    isin: 'INE009A01021',
    instrumentToken: 'NSE_EQ|INE009A01021',
    series: 'EQ',
    sector: 'Information Technology',
    industry: 'IT Services & Consulting',
  },
  {
    exchangeCode: 'NSE',
    symbol: 'HDFCBANK',
    companyName: 'HDFC Bank Limited',
    isin: 'INE040A01034',
    instrumentToken: 'NSE_EQ|INE040A01034',
    series: 'EQ',
    sector: 'Financial Services',
    industry: 'Private Sector Bank',
  },
  {
    exchangeCode: 'NSE',
    symbol: 'ICICIBANK',
    companyName: 'ICICI Bank Limited',
    isin: 'INE090A01021',
    instrumentToken: 'NSE_EQ|INE090A01021',
    series: 'EQ',
    sector: 'Financial Services',
    industry: 'Private Sector Bank',
  },
  // BSE Listings for Dual-Listed Equities
  {
    exchangeCode: 'BSE',
    symbol: '500325', // BSE Scrip Code for Reliance
    companyName: 'Reliance Industries Limited',
    isin: 'INE002A01018',
    instrumentToken: 'BSE_EQ|INE002A01018',
    series: 'A',
    sector: 'Energy',
    industry: 'Oil & Gas - Refining & Marketing',
  },
  {
    exchangeCode: 'BSE',
    symbol: '532540', // BSE Scrip Code for TCS
    companyName: 'Tata Consultancy Services Limited',
    isin: 'INE467B01029',
    instrumentToken: 'BSE_EQ|INE467B01029',
    series: 'A',
    sector: 'Information Technology',
    industry: 'IT Services & Consulting',
  },
];

export async function seed(client = prisma) {
  console.log('--- StockSense AI Database Seeder ---');
  console.log('Seeding Indian Exchanges (NSE & BSE)...');

  const exchangeMap = new Map();

  for (const ex of verifiedExchanges) {
    const exchangeRecord = await client.exchange.upsert({
      where: { code: ex.code },
      update: {
        name: ex.name,
        country: ex.country,
        currency: ex.currency,
        timezone: ex.timezone,
      },
      create: {
        code: ex.code,
        name: ex.name,
        country: ex.country,
        currency: ex.currency,
        timezone: ex.timezone,
      },
    });
    exchangeMap.set(ex.code, exchangeRecord.id);
    console.log(`✔ Exchange synced: ${exchangeRecord.code} (${exchangeRecord.name}) [ID: ${exchangeRecord.id}]`);
  }

  console.log('\nSeeding Verified Blue-Chip Equities...');
  let seededStocksCount = 0;

  for (const stk of verifiedStocks) {
    const exchangeId = exchangeMap.get(stk.exchangeCode);
    if (!exchangeId) {
      console.warn(`Skipping stock ${stk.symbol}: Unknown exchange ${stk.exchangeCode}`);
      continue;
    }

    const segment = stk.segment || (stk.exchangeCode === 'NSE' ? 'NSE_EQ' : 'BSE_EQ');

    const stockRecord = await client.stock.upsert({
      where: {
        instrumentToken: stk.instrumentToken,
      },
      update: {
        companyName: stk.companyName,
        isin: stk.isin,
        segment,
        series: stk.series,
        sector: stk.sector,
        industry: stk.industry,
        isActive: true,
      },
      create: {
        exchangeId,
        symbol: stk.symbol,
        companyName: stk.companyName,
        isin: stk.isin,
        instrumentToken: stk.instrumentToken,
        segment,
        series: stk.series,
        sector: stk.sector,
        industry: stk.industry,
        isActive: true,
      },
    });

    seededStocksCount++;
    console.log(`✔ Stock synced: [${stk.exchangeCode}] ${stockRecord.symbol} - ${stockRecord.companyName} (ISIN: ${stockRecord.isin})`);
  }

  console.log(`\n🎉 Seeding complete. Synced ${exchangeMap.size} exchanges and ${seededStocksCount} verified equities.`);
  return { exchangeCount: exchangeMap.size, stockCount: seededStocksCount };
}

async function runStandalone() {
  try {
    await seed();
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed with error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Execute standalone if called directly via node prisma/seed.js
if (process.argv[1]?.endsWith('seed.js')) {
  runStandalone();
}
