"""
Tests for Technical Pattern Recognition, S/R Clustering & Breakout Analysis
"""

import pytest
import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.services.patterns import TechnicalPatternAnalyzer
from app.schemas.patterns import PatternType, TechnicalStance, LevelType


client = TestClient(app)


def generate_synthetic_candles(n: int = 50, trend: str = "flat", base_price: float = 1000.0):
    """Generate reproducible OHLCV candle series."""
    np.random.seed(42)
    candles = []
    curr = base_price

    for i in range(n):
        if trend == "up":
            curr += 2.0 + np.random.uniform(-1.0, 1.5)
        elif trend == "down":
            curr -= 2.0 + np.random.uniform(-1.0, 1.5)
        else:
            curr += np.random.uniform(-1.5, 1.5)

        o = curr
        c = o + np.random.uniform(-2.0, 2.0)
        h = max(o, c) + abs(np.random.uniform(0.5, 2.0))
        l = min(o, c) - abs(np.random.uniform(0.5, 2.0))
        v = int(np.random.uniform(50000, 150000))

        month = (i // 28) + 1
        day = (i % 28) + 1
        candles.append({
            "timestamp": f"2026-{month:02d}-{day:02d}T09:15:00Z",
            "open": round(o, 2),
            "high": round(h, 2),
            "low": round(l, 2),
            "close": round(c, 2),
            "volume": v,
        })
    return candles


def test_doji_detection():
    candles = generate_synthetic_candles(35, trend="flat")
    # Force a Doji at the last candle: open == close with high and low wicks
    candles[-1]["open"] = 1000.0
    candles[-1]["close"] = 1000.02
    candles[-1]["high"] = 1010.0
    candles[-1]["low"] = 990.0

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "DOJI" for p in res.patterns)
    doji_match = next(p for p in res.patterns if p.code == "DOJI")
    assert doji_match.pattern_type == PatternType.NEUTRAL


def test_hammer_detection():
    candles = generate_synthetic_candles(35, trend="down")
    # Force a Hammer at the last candle: small body at top, long lower wick (>= 2x body), tiny upper wick
    candles[-1]["open"] = 920.0
    candles[-1]["close"] = 922.0  # body = 2.0
    candles[-1]["high"] = 922.5   # upper wick = 0.5 <= 0.15 * range
    candles[-1]["low"] = 912.0    # lower wick = 8.0 >= 2 * body

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "HAMMER" for p in res.patterns)
    hammer = next(p for p in res.patterns if p.code == "HAMMER")
    assert hammer.pattern_type == PatternType.BULLISH


def test_shooting_star_detection():
    candles = generate_synthetic_candles(35, trend="up")
    # Force a Shooting Star: small body at bottom, long upper wick, tiny lower wick
    candles[-1]["open"] = 1100.0
    candles[-1]["close"] = 1098.0  # body = 2.0
    candles[-1]["low"] = 1097.5    # lower wick = 0.5
    candles[-1]["high"] = 1108.0   # upper wick = 8.0 >= 2 * body

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "SHOOTING_STAR" for p in res.patterns)
    star = next(p for p in res.patterns if p.code == "SHOOTING_STAR")
    assert star.pattern_type == PatternType.BEARISH


def test_bullish_engulfing_detection():
    candles = generate_synthetic_candles(35, trend="down")
    # Penultimate candle: red
    candles[-2]["open"] = 950.0
    candles[-2]["close"] = 940.0
    candles[-2]["high"] = 952.0
    candles[-2]["low"] = 938.0

    # Last candle: green, engulfs penultimate body
    candles[-1]["open"] = 938.0
    candles[-1]["close"] = 955.0
    candles[-1]["high"] = 957.0
    candles[-1]["low"] = 936.0

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "BULLISH_ENGULFING" for p in res.patterns)
    engulfing = next(p for p in res.patterns if p.code == "BULLISH_ENGULFING")
    assert engulfing.pattern_type == PatternType.BULLISH


def test_support_resistance_clustering():
    candles = generate_synthetic_candles(60, trend="flat", base_price=1500.0)
    # Inject multiple touches at 1480 (support) and 1520 (resistance)
    for idx in [10, 25, 40]:
        candles[idx]["low"] = 1480.0
        candles[idx]["high"] = 1500.0
        candles[idx]["open"] = 1495.0
        candles[idx]["close"] = 1490.0
    for idx in [15, 30, 45]:
        candles[idx]["high"] = 1520.0
        candles[idx]["low"] = 1500.0
        candles[idx]["open"] = 1505.0
        candles[idx]["close"] = 1510.0

    # Set latest close at 1500
    candles[-1]["close"] = 1500.0

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert len(res.support_resistance) > 0
    # Check that levels have valid properties
    for level in res.support_resistance:
        assert level.level_type in (LevelType.SUPPORT, LevelType.RESISTANCE)
        assert level.touch_count >= 1
        assert 0.0 <= level.strength <= 1.0


def test_donchian_breakout_detection():
    candles = generate_synthetic_candles(50, trend="flat", base_price=1000.0)
    # Force a breakout above the prior 20-candle high
    prior_high = max(c["high"] for c in candles[-21:-1])
    candles[-1]["open"] = prior_high + 5.0
    candles[-1]["close"] = prior_high + 15.0
    candles[-1]["high"] = prior_high + 20.0
    candles[-1]["low"] = prior_high + 2.0
    candles[-1]["volume"] = 300000  # RVOL surge

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(s.signal_type == "DONCHIAN_HIGH_BREAKOUT" for s in res.signals)


def test_morning_star_detection():
    candles = generate_synthetic_candles(35, trend="down")
    # Bar 0: Long red candle
    candles[-3]["open"] = 1000.0
    candles[-3]["close"] = 970.0
    candles[-3]["high"] = 1002.0
    candles[-3]["low"] = 968.0

    # Bar 1: Small star body gapped low
    candles[-2]["open"] = 965.0
    candles[-2]["close"] = 966.0
    candles[-2]["high"] = 968.0
    candles[-2]["low"] = 962.0

    # Bar 2: Bullish green candle penetrating above midpoint (985)
    candles[-1]["open"] = 968.0
    candles[-1]["close"] = 988.0
    candles[-1]["high"] = 990.0
    candles[-1]["low"] = 966.0

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "MORNING_STAR" for p in res.patterns)


def test_three_white_soldiers_detection():
    candles = generate_synthetic_candles(35, trend="flat")
    # 3 consecutive green candles with ascending closes and opens inside prior body
    candles[-3]["open"] = 1000.0
    candles[-3]["close"] = 1010.0
    candles[-3]["high"] = 1011.0
    candles[-3]["low"] = 998.0

    candles[-2]["open"] = 1005.0
    candles[-2]["close"] = 1018.0
    candles[-2]["high"] = 1019.0
    candles[-2]["low"] = 1004.0

    candles[-1]["open"] = 1012.0
    candles[-1]["close"] = 1026.0
    candles[-1]["high"] = 1027.0
    candles[-1]["low"] = 1010.0

    res = TechnicalPatternAnalyzer.analyze(candles)
    assert any(p.code == "THREE_WHITE_SOLDIERS" for p in res.patterns)


def test_fastapi_patterns_analyze_endpoint():
    candles = generate_synthetic_candles(40, trend="up", base_price=2400.0)
    response = client.post(
        "/api/patterns/analyze",
        json={"candles": candles, "symbol": "RELIANCE"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "stance" in data
    assert "technical_score" in data
    assert -1.0 <= data["technical_score"] <= 1.0
    assert "summary" in data
    assert "patterns" in data
    assert "support_resistance" in data
    assert "signals" in data
    assert "indicators" in data
    assert data["indicators"]["close_price"] > 0
    assert data["meta"]["symbol"] == "RELIANCE"


def test_patterns_analyze_empty_payload():
    response = client.post("/api/patterns/analyze", json={"candles": []})
    assert response.status_code == 400
