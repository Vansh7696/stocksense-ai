"""
StockSense AI — Executable Target-Label Generation Test Suite
Validates mathematical accuracy of forward executable returns, 3-class target labeling,
threshold boundaries, missing trading-session detection against expected calendar,
comprehensive OHLCV relationship checks (high >= max(open, close), low <= min(open, close), volume >= 0),
session indexing (including special Budget/Muhurat sessions), multi-stock/exchange isolation,
fail-closed API behavior, and strict leakage protection.
"""

import math
import copy
import json
import os
import pytest
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient

from app.main import app
from app.config import target_settings
from app.schemas.targets import (
    TargetClass,
    TargetType,
    TargetRecord,
    TargetThresholdConfig,
)
from app.services.targets import (
    calculate_executable_return,
    calculate_close_to_close_return,
    classify_target,
    generate_targets,
    TargetService,
    TargetGenerationResult,
    normalize_candle_timestamp,
    validate_expected_sessions,
)
from app.services.features import FeatureEngineeringPipeline
from tests.test_indicators import generate_synthetic_candles

client = TestClient(app)


# =============================================================================
# Helper Fixtures & Builders
# =============================================================================

def build_deterministic_candles(prices: list[tuple[float, float, float, float]], dates: list[str] = None) -> list[dict]:
    """
    Builds candle records from a list of (open, high, low, close) tuples.
    Guarantees valid bar geometry (high >= max(open, close), low <= min(open, close), volume >= 0).
    """
    candles = []
    base_date = datetime(2025, 1, 1, 9, 15, tzinfo=timezone.utc)
    for i, (op, hi, lo, cl) in enumerate(prices):
        if dates and i < len(dates):
            date_str = dates[i]
        else:
            date_str = (base_date + timedelta(days=i)).strftime("%Y-%m-%d")
        candles.append({
            "timestamp": date_str,
            "open": float(op),
            "high": float(hi),
            "low": float(lo),
            "close": float(cl),
            "volume": 100000.0,
        })
    return candles


# =============================================================================
# A. Return Calculations
# =============================================================================

class TestReturnCalculations:
    def test_pure_function_executable_return_formula(self):
        # Entry open = 100.0, Exit close = 105.0 -> ((105 - 100) / 100) * 100 = +5.0%
        ret = calculate_executable_return(100.0, 105.0)
        assert ret == pytest.approx(5.0)

    def test_pure_function_zero_return(self):
        ret = calculate_executable_return(250.0, 250.0)
        assert ret == pytest.approx(0.0)

    def test_pure_function_negative_return(self):
        # Entry open = 200.0, Exit close = 194.0 -> ((194 - 200) / 200) * 100 = -3.0%
        ret = calculate_executable_return(200.0, 194.0)
        assert ret == pytest.approx(-3.0)

    def test_pure_function_close_to_close_return(self):
        # Signal close = 100.0, Exit close = 103.0 -> +3.0%
        ret = calculate_close_to_close_return(100.0, 103.0)
        assert ret == pytest.approx(3.0)

    def test_horizon_1_executable_calculation(self):
        # Session 0: C0 = 100.0 (Signal)
        # Session 1: O1 = 102.0 (Entry proxy), C1 = 104.04 (Exit proxy for h=1)
        # R(0, 1) = ((104.04 - 102.0) / 102.0) * 100 = +2.0%
        candles = build_deterministic_candles([
            (99.0, 101.0, 98.0, 100.0),    # t = 0
            (102.0, 105.0, 101.0, 104.04), # t = 1 (O1 = 102, C1 = 104.04)
        ])
        calendar = [c["timestamp"] for c in candles]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=calendar)

        assert result.total_targets == 1
        tgt = result.targets[0]
        assert tgt.signal_session_index == 0
        assert tgt.entry_session_index == 1
        assert tgt.exit_session_index == 1
        assert tgt.entry_open_price == 102.0
        assert tgt.exit_close_price == 104.04
        assert tgt.executable_return_pct == pytest.approx(2.0, rel=1e-4)
        assert tgt.target_class == TargetClass.UP
        assert tgt.target_label == 1

    def test_horizon_3_executable_calculation(self):
        # Session 0: Signal close
        # Session 1: Entry open O1 = 200.0
        # Session 2: Intermediate
        # Session 3: Exit close C3 = 196.0 -> ((196 - 200) / 200) * 100 = -2.0%
        candles = build_deterministic_candles([
            (195.0, 201.0, 194.0, 199.0),  # t = 0
            (200.0, 203.0, 199.0, 201.0),  # t = 1 (Entry O1 = 200)
            (201.0, 204.0, 200.0, 202.0),  # t = 2
            (202.0, 203.0, 195.0, 196.0),  # t = 3 (Exit C3 = 196)
        ])
        calendar = [c["timestamp"] for c in candles]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[3], expected_sessions=calendar)

        assert result.total_targets == 1
        tgt = result.targets[0]
        assert tgt.signal_session_index == 0
        assert tgt.entry_session_index == 1
        assert tgt.exit_session_index == 3
        assert tgt.entry_open_price == 200.0
        assert tgt.exit_close_price == 196.0
        assert tgt.executable_return_pct == pytest.approx(-2.0, rel=1e-4)
        assert tgt.target_class == TargetClass.DOWN
        assert tgt.target_label == -1

    def test_horizon_5_executable_calculation(self):
        # Session 0: Signal
        # Session 1: Entry open O1 = 500.0
        # Sessions 2, 3, 4: Intermediates
        # Session 5: Exit close C5 = 505.0 -> ((505 - 500) / 500) * 100 = +1.0%
        candles = build_deterministic_candles([
            (498.0, 502.0, 497.0, 500.0),  # 0
            (500.0, 504.0, 499.0, 502.0),  # 1 (O1 = 500)
            (502.0, 505.0, 501.0, 503.0),  # 2
            (503.0, 506.0, 502.0, 504.0),  # 3
            (504.0, 507.0, 503.0, 505.0),  # 4
            (505.0, 508.0, 503.0, 505.0),  # 5 (C5 = 505)
        ])
        calendar = [c["timestamp"] for c in candles]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[5], expected_sessions=calendar)

        assert result.total_targets == 1
        tgt = result.targets[0]
        assert tgt.signal_session_index == 0
        assert tgt.entry_session_index == 1
        assert tgt.exit_session_index == 5
        assert tgt.entry_open_price == 500.0
        assert tgt.exit_close_price == 505.0
        assert tgt.executable_return_pct == pytest.approx(1.0, rel=1e-4)
        # For h=5, threshold is 1.50%. +1.0% is within [-1.50%, +1.50%] -> NEUTRAL (0)
        assert tgt.target_class == TargetClass.NEUTRAL
        assert tgt.target_label == 0


# =============================================================================
# B. Classification Boundaries
# =============================================================================

class TestClassificationBoundaries:
    """
    Checks exact threshold boundaries:
    - DOWN: return < -theta
    - NEUTRAL: -theta <= return <= +theta
    - UP: return > +theta
    """

    def test_horizon_1_boundary_conditions(self):
        # h=1 threshold is 0.50%
        cls, lbl = classify_target(-0.50, horizon=1)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(-0.50001, horizon=1)
        assert cls == TargetClass.DOWN
        assert lbl == -1

        cls, lbl = classify_target(0.50, horizon=1)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(0.50001, horizon=1)
        assert cls == TargetClass.UP
        assert lbl == 1

        cls, lbl = classify_target(0.0, horizon=1)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

    def test_horizon_3_boundary_conditions(self):
        # h=3 threshold is 1.00%
        cls, lbl = classify_target(-1.00, horizon=3)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(-1.0001, horizon=3)
        assert cls == TargetClass.DOWN
        assert lbl == -1

        cls, lbl = classify_target(1.00, horizon=3)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(1.0001, horizon=3)
        assert cls == TargetClass.UP
        assert lbl == 1

    def test_horizon_5_boundary_conditions(self):
        # h=5 threshold is 1.50%
        cls, lbl = classify_target(-1.50, horizon=5)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(-1.5001, horizon=5)
        assert cls == TargetClass.DOWN
        assert lbl == -1

        cls, lbl = classify_target(1.50, horizon=5)
        assert cls == TargetClass.NEUTRAL
        assert lbl == 0

        cls, lbl = classify_target(1.5001, horizon=5)
        assert cls == TargetClass.UP
        assert lbl == 1

    def test_unsupported_horizon_raises_error(self):
        with pytest.raises(ValueError, match="Horizon 10 not configured"):
            classify_target(1.0, horizon=10)

    def test_invalid_return_value_raises_error(self):
        with pytest.raises(ValueError, match="Invalid return_pct"):
            classify_target(float("nan"), horizon=1)


# =============================================================================
# C. Missing and Invalid Data Handling (Low-Level & Sanitization)
# =============================================================================

class TestMissingAndInvalidData:
    def test_missing_entry_candle_at_series_end(self):
        # 2 candles: index 0 and index 1.
        # For signal at index 1: entry requires index 2, which does not exist -> excluded
        candles = build_deterministic_candles([
            (100.0, 102.0, 99.0, 101.0),
            (101.0, 103.0, 100.0, 102.0),
        ])
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert result.total_targets == 1
        assert result.total_exclusions == 1
        excl = result.exclusions[0]
        assert excl.signal_session_index == 1
        assert excl.reason == "MISSING_ENTRY_CANDLE"

    def test_missing_exit_candle_at_horizon_boundary(self):
        # 3 candles: 0, 1, 2. For h=3: signal 0 requires exit at 0 + 3 = 3 -> excluded
        candles = build_deterministic_candles([
            (100.0, 102.0, 99.0, 101.0),
            (101.0, 103.0, 100.0, 102.0),
            (102.0, 104.0, 101.0, 103.0),
        ])
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[3], allow_unverified_session_sequence=True)

        assert result.total_targets == 0
        assert result.total_exclusions >= 1
        assert any(e.reason == "MISSING_EXIT_CANDLE" for e in result.exclusions)

    def test_zero_entry_price_excluded(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 0.0, "high": 102.0, "low": 0.0, "close": 101.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert result.total_targets == 0
        assert result.total_exclusions >= 1
        reasons = [e.reason for e in result.exclusions]
        assert any("NON_POSITIVE" in r for r in reasons)

    def test_negative_price_excluded(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": -50.0, "high": 102.0, "low": -60.0, "close": 101.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)
        assert result.total_targets == 0
        assert any("NON_POSITIVE" in e.reason for e in result.exclusions)

    def test_nan_price_excluded(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": float("nan"), "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)
        assert result.total_targets == 0
        assert any("NAN" in e.reason for e in result.exclusions)

    def test_infinite_price_excluded(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": float("inf"), "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)
        assert result.total_targets == 0
        assert any("INFINITE" in e.reason for e in result.exclusions)

    def test_duplicate_timestamps_deduplicated_with_audit(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-01", "open": 100.5, "high": 102.5, "low": 99.5, "close": 101.5, "volume": 150.0},
            {"timestamp": "2025-01-02", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 120.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert result.total_targets == 1
        assert any(e.reason == "DEDUPLICATED_TIMESTAMP_KEEP_LAST" for e in result.exclusions)

    def test_out_of_order_timestamps_sorted_chronologically(self):
        candles = [
            {"timestamp": "2025-01-03", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "volume": 100.0},
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        df = result.to_dataframe()
        assert len(df) == 2
        assert df.iloc[0]["signal_date"] == "2025-01-01"
        assert df.iloc[0]["entry_date"] == "2025-01-02"
        assert df.iloc[1]["signal_date"] == "2025-01-02"
        assert df.iloc[1]["entry_date"] == "2025-01-03"


# =============================================================================
# D. Missing Trading-Session Detection & Calendar Validation (Regression Suite)
# =============================================================================

class TestMissingTradingSessionDetection:
    def test_fail_closed_when_expected_sessions_missing_in_service(self):
        """
        TargetService.generate must fail closed with a clear ValueError if expected_sessions
        is missing and allow_unverified_session_sequence=False.
        """
        candles = build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)])
        service = TargetService()
        with pytest.raises(ValueError, match="An explicitly verified expected_sessions calendar is required"):
            service.generate(candles, symbol="TEST", horizons=[1])

    def test_api_request_without_expected_sessions_fails_closed(self):
        """
        The FastAPI endpoint must fail closed with HTTP 422 if expected_sessions is omitted.
        """
        candles = generate_synthetic_candles(10, trend=0.2)
        payload = {
            "symbol": "RELIANCE",
            "candles": candles,
            "horizons": [1, 3],
        }
        response = client.post("/api/targets/generate", json=payload)
        assert response.status_code == 422
        assert "expected_sessions calendar is required" in response.json()["detail"]

    def test_missing_intermediate_wednesday_detected(self):
        """
        Detects an absent expected Wednesday between Tuesday and Thursday.
        """
        calendar = ["2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10"]
        # Stock candles skip Wednesday 2025-01-08
        candles = [
            {"timestamp": "2025-01-06", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-07", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
            {"timestamp": "2025-01-09", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "volume": 100.0},
            {"timestamp": "2025-01-10", "open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1, 3], expected_sessions=calendar)

        # For signal 2025-01-07 (Tuesday):
        # Entry requires Wednesday 2025-01-08. Since it is absent, must record MISSING_ENTRY_TRADING_SESSION
        tue_excl_h1 = [
            e for e in result.exclusions
            if e.signal_date == "2025-01-07" and e.prediction_horizon == 1
        ]
        assert len(tue_excl_h1) == 1
        assert tue_excl_h1[0].reason == "MISSING_ENTRY_TRADING_SESSION"
        assert tue_excl_h1[0].details["expected_entry_date"] == "2025-01-08"

        # For signal 2025-01-06 (Monday), h=3:
        # Exit requires Thursday 2025-01-09, and intermediate offset 2 requires Wednesday 2025-01-08.
        # Since Wednesday is missing in candles, it must record MISSING_INTERMEDIATE_TRADING_SESSION or MISSING_EXIT_TRADING_SESSION
        mon_excl_h3 = [
            e for e in result.exclusions
            if e.signal_date == "2025-01-06" and e.prediction_horizon == 3
        ]
        assert len(mon_excl_h3) == 1
        assert "MISSING" in mon_excl_h3[0].reason

    def test_missing_intermediate_session_for_h3_and_h5(self):
        """
        Tests missing intermediate session detection for h=3 and h=5.
        """
        # Calendar: 7 sessions (Day 0 to 6)
        calendar = [f"2025-01-{i+1:02d}" for i in range(7)]
        # Candle sequence missing Day 3 (2025-01-03)
        candles = [
            {"timestamp": "2025-01-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100},
            {"timestamp": "2025-01-02", "open": 101, "high": 103, "low": 100, "close": 102, "volume": 100},
            # 2025-01-03 is MISSING
            {"timestamp": "2025-01-04", "open": 103, "high": 105, "low": 102, "close": 104, "volume": 100},
            {"timestamp": "2025-01-05", "open": 104, "high": 106, "low": 103, "close": 105, "volume": 100},
            {"timestamp": "2025-01-06", "open": 105, "high": 107, "low": 104, "close": 106, "volume": 100},
            {"timestamp": "2025-01-07", "open": 106, "high": 108, "low": 105, "close": 107, "volume": 100},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[3, 5], expected_sessions=calendar)

        # Signal 2025-01-01:
        # h=3 requires sessions 1, 2, 3 (2025-01-02, 2025-01-03, 2025-01-04)
        # Because 2025-01-03 is missing, h=3 must be excluded with MISSING_INTERMEDIATE_TRADING_SESSION
        sig_01_excl = [e for e in result.exclusions if e.signal_date == "2025-01-01"]
        assert any(e.reason == "MISSING_INTERMEDIATE_TRADING_SESSION" for e in sig_01_excl)

    def test_weekend_budget_and_muhurat_sessions_in_expected_calendar(self):
        """
        Verifies that special weekend trading sessions (Saturday Budget session and Sunday Muhurat session)
        are cleanly accepted and generate valid target labels when present in expected_sessions.
        """
        calendar = ["2025-01-31", "2025-02-01", "2025-02-03"] # Friday -> Saturday (Budget) -> Monday
        candles = [
            {"timestamp": "2025-01-31", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-02-01", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 100.0}, # Saturday
            {"timestamp": "2025-02-03", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "volume": 100.0}, # Monday
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=calendar)

        assert result.total_targets == 2
        df = result.to_dataframe()
        row0 = df[df["signal_date"] == "2025-01-31"].iloc[0]
        # Next entry session must be Saturday 2025-02-01
        assert row0["entry_date"] == "2025-02-01"
        assert row0["entry_open_price"] == 102.0

    def test_market_holidays_excluded_from_expected_sessions(self):
        """
        When a legitimate exchange holiday is not in expected_sessions, skipping that day
        is treated as valid consecutive trading days without false gap alerts.
        """
        # Calendar: 2025-01-24 (Fri) -> 2025-01-27 (Mon). (2025-01-26 is Republic Day holiday)
        calendar = ["2025-01-24", "2025-01-27"]
        candles = [
            {"timestamp": "2025-01-24", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-27", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=calendar)

        assert result.total_targets == 1
        df = result.to_dataframe()
        assert df.iloc[0]["signal_date"] == "2025-01-24"
        assert df.iloc[0]["entry_date"] == "2025-01-27"


# =============================================================================
# E. Comprehensive OHLCV Validation & Integrity Checks
# =============================================================================

class TestComprehensiveOHLCVValidation:
    def test_negative_volume_rejected(self):
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": -50.0},
            {"timestamp": "2025-01-02", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert any(e.reason == "NEGATIVE_VOLUME" for e in result.exclusions)

    def test_missing_volume_column_rejected(self):
        df_invalid = pd.DataFrame([
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0},
            {"timestamp": "2025-01-02", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0},
        ])
        service = TargetService()
        with pytest.raises(ValueError, match="Missing required OHLCV columns.*volume"):
            service.generate(df_invalid, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

    def test_high_lower_than_open_rejected(self):
        candles = [
            # High 99.0 is less than Open 100.0
            {"timestamp": "2025-01-01", "open": 100.0, "high": 99.0, "low": 95.0, "close": 98.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 98.0, "high": 100.0, "low": 97.0, "close": 99.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert any(e.reason == "INVALID_BAR_HIGH_LT_OPEN" for e in result.exclusions)

    def test_high_lower_than_close_rejected(self):
        candles = [
            # High 100.0 is less than Close 102.0
            {"timestamp": "2025-01-01", "open": 99.0, "high": 100.0, "low": 98.0, "close": 102.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert any(e.reason == "INVALID_BAR_HIGH_LT_CLOSE" for e in result.exclusions)

    def test_low_higher_than_open_rejected(self):
        candles = [
            # Low 101.0 is greater than Open 100.0
            {"timestamp": "2025-01-01", "open": 100.0, "high": 105.0, "low": 101.0, "close": 104.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert any(e.reason == "INVALID_BAR_LOW_GT_OPEN" for e in result.exclusions)

    def test_low_higher_than_close_rejected(self):
        candles = [
            # Low 100.0 is greater than Close 98.0
            {"timestamp": "2025-01-01", "open": 102.0, "high": 105.0, "low": 100.0, "close": 98.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 98.0, "high": 101.0, "low": 97.0, "close": 100.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)

        assert any(e.reason == "INVALID_BAR_LOW_GT_CLOSE" for e in result.exclusions)

    def test_intermediate_candle_geometry_failure_aborts_horizon(self):
        """
        Intermediate bar with high < close must be caught and abort horizon target generation.
        """
        # Session 2 has high (100.0) < close (102.0)
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
            {"timestamp": "2025-01-03", "open": 99.0, "high": 100.0, "low": 98.0, "close": 102.0, "volume": 100.0}, # Corrupt
            {"timestamp": "2025-01-04", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[3], allow_unverified_session_sequence=True)

        # Corrupt candle at 2025-01-03 is dropped in _prepare_candles_df with INVALID_BAR_HIGH_LT_CLOSE
        assert any(e.reason == "INVALID_BAR_HIGH_LT_CLOSE" for e in result.exclusions)
        assert result.total_targets == 0

    def test_existing_valid_candles_continue_to_pass(self):
        candles = build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)])
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], allow_unverified_session_sequence=True)
        assert result.total_targets == 1
        assert len([e for e in result.exclusions if "INVALID" in e.reason]) == 0


# =============================================================================
# F. Isolation and Reproducibility
# =============================================================================

class TestIsolationAndReproducibility:
    def test_nse_and_bse_isolation_same_symbol(self):
        nse_candles = [
            {"stock_symbol": "RELIANCE", "exchange_id": "NSE", "timestamp": "2025-01-01", "open": 2500.0, "high": 2520.0, "low": 2490.0, "close": 2510.0, "volume": 1000.0},
            {"stock_symbol": "RELIANCE", "exchange_id": "NSE", "timestamp": "2025-01-02", "open": 2520.0, "high": 2540.0, "low": 2510.0, "close": 2530.0, "volume": 1200.0},
        ]
        bse_candles = [
            {"stock_symbol": "RELIANCE", "exchange_id": "BSE", "timestamp": "2025-01-01", "open": 2490.0, "high": 2510.0, "low": 2480.0, "close": 2500.0, "volume": 500.0},
            {"stock_symbol": "RELIANCE", "exchange_id": "BSE", "timestamp": "2025-01-02", "open": 2505.0, "high": 2525.0, "low": 2495.0, "close": 2515.0, "volume": 600.0},
        ]
        pooled_candles = nse_candles + bse_candles

        service = TargetService()
        result = service.generate_multi_stock(pooled_candles, horizons=[1], allow_unverified_session_sequence=True)

        df = result.to_dataframe()
        assert len(df) == 2

        nse_row = df[df["exchange_id"] == "NSE"].iloc[0]
        bse_row = df[df["exchange_id"] == "BSE"].iloc[0]

        assert nse_row["entry_open_price"] == 2520.0
        assert nse_row["exit_close_price"] == 2530.0
        assert bse_row["entry_open_price"] == 2505.0
        assert bse_row["exit_close_price"] == 2515.0

    def test_multi_stock_independence(self):
        tcs_candles = generate_synthetic_candles(30, trend=0.5, base_price=3500.0)
        infy_candles = generate_synthetic_candles(30, trend=-0.3, base_price=1800.0)

        for c in tcs_candles:
            c["symbol"] = "TCS"
            c["exchange_id"] = "NSE"
        for c in infy_candles:
            c["symbol"] = "INFY"
            c["exchange_id"] = "NSE"

        service = TargetService()

        calendar_tcs = [normalize_candle_timestamp(c["timestamp"])[1] for c in tcs_candles]
        calendar_infy = [normalize_candle_timestamp(c["timestamp"])[1] for c in infy_candles]

        res_tcs = service.generate(tcs_candles, symbol="TCS", horizons=[1, 3], expected_sessions=calendar_tcs)
        res_infy = service.generate(infy_candles, symbol="INFY", horizons=[1, 3], expected_sessions=calendar_infy)

        res_multi = service.generate_multi_stock(
            tcs_candles + infy_candles,
            horizons=[1, 3],
            expected_sessions={"TCS": calendar_tcs, "INFY": calendar_infy},
        )
        df_multi = res_multi.to_dataframe()

        df_multi_tcs = df_multi[df_multi["stock_symbol"] == "TCS"].reset_index(drop=True)
        df_multi_infy = df_multi[df_multi["stock_symbol"] == "INFY"].reset_index(drop=True)

        df_tcs_solo = res_tcs.to_dataframe().reset_index(drop=True)
        df_infy_solo = res_infy.to_dataframe().reset_index(drop=True)

        pd.testing.assert_frame_equal(df_multi_tcs, df_tcs_solo)
        pd.testing.assert_frame_equal(df_multi_infy, df_infy_solo)

    def test_deterministic_reproducibility(self):
        candles = generate_synthetic_candles(50, trend=0.2, base_price=1000.0)
        calendar = [normalize_candle_timestamp(c["timestamp"])[1] for c in candles]
        service = TargetService()

        run1 = service.generate(candles, symbol="RELIANCE", horizons=[1, 3, 5], expected_sessions=calendar)
        run2 = service.generate(candles, symbol="RELIANCE", horizons=[1, 3, 5], expected_sessions=calendar)

        assert run1.total_targets == run2.total_targets
        assert run1.total_exclusions == run2.total_exclusions

        df1 = run1.to_dataframe()
        df2 = run2.to_dataframe()
        pd.testing.assert_frame_equal(df1, df2)


# =============================================================================
# G. Leakage Protection
# =============================================================================

class TestLeakageProtection:
    def test_feature_matrix_never_contains_future_prices(self):
        candles = generate_synthetic_candles(60, trend=0.2)
        pipeline = FeatureEngineeringPipeline()
        feature_output = pipeline.extract_features(candles, drop_na=False)

        forbidden_substrings = [
            "target", "future", "entry", "exit", "label",
            "open_t1", "close_th", "return_target",
        ]
        for name in feature_output["feature_names"]:
            for forbidden in forbidden_substrings:
                assert forbidden not in name.lower(), f"Potential target leakage in feature column: {name}"

    def test_mutating_future_prices_leaves_past_features_unaltered(self):
        candles_original = generate_synthetic_candles(50, trend=0.1, base_price=1000.0)
        candles_mutated = copy.deepcopy(candles_original)

        for i in range(30, len(candles_mutated)):
            candles_mutated[i]["open"] *= 10.0
            candles_mutated[i]["high"] *= 10.0
            candles_mutated[i]["low"] *= 10.0
            candles_mutated[i]["close"] *= 10.0
            candles_mutated[i]["volume"] *= 5.0

        pipeline = FeatureEngineeringPipeline()
        features_orig = pipeline.extract_features(candles_original, drop_na=False)["features"]
        features_mut = pipeline.extract_features(candles_mutated, drop_na=False)["features"]

        for idx in range(30):
            orig_row = features_orig[idx]
            mut_row = features_mut[idx]
            assert orig_row["timestamp"] == mut_row["timestamp"]
            for col in orig_row:
                if col == "timestamp":
                    continue
                v_orig = orig_row[col]
                v_mut = mut_row[col]
                if v_orig is None:
                    assert v_mut is None
                else:
                    assert v_orig == pytest.approx(v_mut, rel=1e-5), (
                        f"Leakage detected at index {idx} in feature '{col}': {v_orig} != {v_mut}"
                    )

    def test_functional_generate_targets_interface(self):
        candles = generate_synthetic_candles(20, trend=0.2)
        calendar = [normalize_candle_timestamp(c["timestamp"])[1] for c in candles]
        df_candles = pd.DataFrame(candles)

        df_targets_exec = generate_targets(
            df_candles,
            horizons=[1, 3, 5],
            target_type="open_to_close",
            expected_sessions=calendar,
        )
        assert not df_targets_exec.empty
        assert "executable_return_pct" in df_targets_exec.columns
        assert "target_class" in df_targets_exec.columns

        df_targets_c2c = generate_targets(
            df_candles,
            horizons=[1, 3, 5],
            target_type="close_to_close",
            expected_sessions=calendar,
        )
        assert not df_targets_c2c.empty
        assert len(df_targets_c2c) >= len(df_targets_exec)


# =============================================================================
# H. API Integration Tests
# =============================================================================

class TestTargetsAPIEndpoint:
    def test_post_targets_generate_success_with_expected_sessions(self):
        candles = generate_synthetic_candles(25, trend=0.3)
        calendar = [normalize_candle_timestamp(c["timestamp"])[1] for c in candles]
        payload = {
            "symbol": "RELIANCE",
            "stock_id": "test-uuid-reliance",
            "exchange_id": "NSE",
            "candles": candles,
            "horizons": [1, 3],
            "expected_sessions": calendar,
        }
        response = client.post("/api/targets/generate", json=payload)
        assert response.status_code == 200
        data = response.json()

        assert data["symbol"] == "RELIANCE"
        assert data["stock_id"] == "test-uuid-reliance"
        assert data["exchange_id"] == "NSE"
        assert data["total_candles"] == 25
        assert data["total_targets_generated"] > 0
        assert len(data["targets"]) == data["total_targets_generated"]

        first_target = data["targets"][0]
        assert "signal_session_index" in first_target
        assert "entry_session_index" in first_target
        assert "exit_session_index" in first_target
        assert "entry_open_price" in first_target
        assert "exit_close_price" in first_target
        assert "executable_return_pct" in first_target
        assert "target_class" in first_target
        assert "target_label" in first_target
        assert first_target["target_class"] in ["DOWN", "NEUTRAL", "UP"]
        assert first_target["target_label"] in [-1, 0, 1]

    def test_post_targets_generate_insufficient_candles(self):
        payload = {
            "symbol": "RELIANCE",
            "candles": [{"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0}],
            "expected_sessions": ["2025-01-01"],
        }
        response = client.post("/api/targets/generate", json=payload)
        assert response.status_code in [400, 422]


# =============================================================================
# I. Historical Dataset Regression Test (Verified 544 Calendar Dates)
# =============================================================================

class TestHistoricalDatasetRegression:
    def test_historical_8115_targets_reproduced_with_verified_calendar(self):
        """
        Verifies that when the verified 544 clean calendar sessions are supplied,
        exactly 8,115 targets and 45 exclusions are produced across all 5 stocks.
        """
        path = "/Users/vansh/.gemini/antigravity/brain/0dd47e33-8dcd-41dc-b48c-008944fca820/scratch/five_stocks_candles.json"
        if not os.path.exists(path):
            pytest.skip("Historical scratch dataset not available")

        with open(path) as f:
            data = json.load(f)

        # 544 clean dates from clean window in Asia/Kolkata YYYY-MM-DD
        clean_calendar = [normalize_candle_timestamp(c["timestamp"])[1] for c in data["RELIANCE"]["candles"][199:]]
        assert len(clean_calendar) == 544

        service = TargetService()
        pooled_targets = []
        pooled_exclusions = []

        for symbol, stock_info in data.items():
            candles = stock_info["candles"][199:]
            result = service.generate(
                candles,
                symbol=symbol,
                horizons=[1, 3, 5],
                expected_sessions=clean_calendar,
            )
            df = result.to_dataframe()
            pooled_targets.append(df)
            pooled_exclusions.extend(result.exclusions)

        all_df = pd.concat(pooled_targets, ignore_index=True)

        assert len(all_df) == 8115, f"Expected 8115 targets, got {len(all_df)}"
        assert len(pooled_exclusions) == 45, f"Expected 45 exclusions, got {len(pooled_exclusions)}"

        # Verify exact class counts
        h1_counts = all_df[all_df["prediction_horizon"] == 1]["target_class"].value_counts().to_dict()
        assert h1_counts == {"NEUTRAL": 1023, "DOWN": 895, "UP": 797}

        h3_counts = all_df[all_df["prediction_horizon"] == 3]["target_class"].value_counts().to_dict()
        assert h3_counts == {"NEUTRAL": 1046, "DOWN": 892, "UP": 767}

        h5_counts = all_df[all_df["prediction_horizon"] == 5]["target_class"].value_counts().to_dict()
        assert h5_counts == {"NEUTRAL": 1161, "DOWN": 839, "UP": 695}


# =============================================================================
# J. Strict Expected-Session Calendar Structural Validation Tests
# =============================================================================

class TestStrictCalendarValidation:
    def test_reject_duplicate_dates_service_and_api(self):
        cal_with_dupe = ["2025-01-01", "2025-01-02", "2025-01-02", "2025-01-03"]
        # Service level
        with pytest.raises(ValueError, match="duplicate session date"):
            validate_expected_sessions(cal_with_dupe)

        candles = build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)])
        service = TargetService()
        with pytest.raises(ValueError, match="duplicate session date"):
            service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=cal_with_dupe)

        # API level (Pydantic validator returns 422)
        payload = {
            "symbol": "RELIANCE",
            "candles": candles,
            "horizons": [1],
            "expected_sessions": cal_with_dupe,
        }
        res = client.post("/api/targets/generate", json=payload)
        assert res.status_code == 422
        assert "duplicate session date" in res.text

    def test_reject_unsorted_dates_service_and_api(self):
        cal_unsorted = ["2025-01-01", "2025-01-05", "2025-01-03"]
        # Service level
        with pytest.raises(ValueError, match="strictly ascending chronological order"):
            validate_expected_sessions(cal_unsorted)

        candles = build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)])
        service = TargetService()
        with pytest.raises(ValueError, match="strictly ascending chronological order"):
            service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=cal_unsorted)

        # API level
        payload = {
            "symbol": "RELIANCE",
            "candles": candles,
            "horizons": [1],
            "expected_sessions": cal_unsorted,
        }
        res = client.post("/api/targets/generate", json=payload)
        assert res.status_code == 422
        assert "strictly ascending chronological order" in res.text

    def test_reject_invalid_date_formats_service_and_api(self):
        invalid_formats = [
            ["2025/01/01", "2025/01/02"],
            ["01-01-2025", "02-01-2025"],
            ["2025-1-1", "2025-1-2"],
            ["2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z"],
        ]
        for cal in invalid_formats:
            with pytest.raises(ValueError, match="strict ISO 'YYYY-MM-DD' format"):
                validate_expected_sessions(cal)

            payload = {
                "symbol": "RELIANCE",
                "candles": build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)]),
                "horizons": [1],
                "expected_sessions": cal,
            }
            res = client.post("/api/targets/generate", json=payload)
            assert res.status_code == 422
            assert "strict ISO 'YYYY-MM-DD' format" in res.text

    def test_reject_impossible_calendar_dates_service_and_api(self):
        impossible_dates = [
            ["2025-02-31", "2025-03-01"],
            ["2025-04-31", "2025-05-01"],
            ["2025-13-01", "2025-13-02"],
        ]
        for cal in impossible_dates:
            with pytest.raises(ValueError, match="impossible or invalid calendar date"):
                validate_expected_sessions(cal)

            payload = {
                "symbol": "RELIANCE",
                "candles": build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)]),
                "horizons": [1],
                "expected_sessions": cal,
            }
            res = client.post("/api/targets/generate", json=payload)
            assert res.status_code == 422
            assert "impossible or invalid calendar date" in res.text

    def test_reject_empty_or_whitespace_strings_service_and_api(self):
        whitespace_cals = [
            ["", "2025-01-02"],
            ["   ", "2025-01-02"],
            [" 2025-01-01", "2025-01-02"],
            ["2025-01-01 ", "2025-01-02"],
        ]
        for cal in whitespace_cals:
            with pytest.raises(ValueError, match="invalid whitespace or is empty"):
                validate_expected_sessions(cal)

            payload = {
                "symbol": "RELIANCE",
                "candles": build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)]),
                "horizons": [1],
                "expected_sessions": cal,
            }
            res = client.post("/api/targets/generate", json=payload)
            assert res.status_code == 422
            assert "invalid whitespace or is empty" in res.text

    def test_reject_empty_calendar_list_service_and_api(self):
        # Empty list
        with pytest.raises(ValueError, match="cannot be empty"):
            validate_expected_sessions([])

        candles = build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)])
        service = TargetService()
        with pytest.raises(ValueError, match="cannot be empty"):
            service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=[])

        payload = {
            "symbol": "RELIANCE",
            "candles": candles,
            "horizons": [1],
            "expected_sessions": [],
        }
        res = client.post("/api/targets/generate", json=payload)
        assert res.status_code == 422
        assert "cannot be empty" in res.text

    def test_reject_non_string_entries_service_and_api(self):
        non_strings = [["2025-01-01", 20250102]]
        with pytest.raises(ValueError, match="must be a string"):
            validate_expected_sessions(non_strings[0])

        payload = {
            "symbol": "RELIANCE",
            "candles": build_deterministic_candles([(100, 102, 99, 101), (101, 103, 100, 102)]),
            "horizons": [1],
            "expected_sessions": non_strings[0],
        }
        res = client.post("/api/targets/generate", json=payload)
        assert res.status_code == 422


# =============================================================================
# K. Explicit Timestamp and Timezone Policy Tests
# =============================================================================

class TestTimestampAndTimezonePolicy:
    def test_normalize_equivalent_instants(self):
        """
        Equivalent UTC and IST representations of the same instant must resolve
        to the exact same Asia/Kolkata session date (2026-11-09).
        """
        ist_ts = "2026-11-09T09:15:00+05:30"
        utc_ts = "2026-11-09T03:45:00Z"

        dt_ist, date_ist = normalize_candle_timestamp(ist_ts)
        dt_utc, date_utc = normalize_candle_timestamp(utc_ts)

        assert date_ist == "2026-11-09"
        assert date_utc == "2026-11-09"
        assert dt_ist == dt_utc

    def test_normalize_late_utc_instant_crosses_day_boundary(self):
        """
        Late UTC timestamps (e.g. 2026-11-08T18:30:00Z) correspond to 2026-11-09 00:00:00 IST
        and must resolve to the next day's session date (2026-11-09).
        Conversely, 2026-11-08T18:29:59Z corresponds to 23:59:59 IST on 2026-11-08.
        """
        dt1, d1 = normalize_candle_timestamp("2026-11-08T18:30:00Z")
        assert d1 == "2026-11-09"

        dt2, d2 = normalize_candle_timestamp("2026-11-08T18:29:59Z")
        assert d2 == "2026-11-08"

    def test_normalize_negative_offset(self):
        """
        Negative offset timestamps (e.g. US Eastern EST 22:45 is next day 09:15 IST).
        """
        _, d = normalize_candle_timestamp("2026-11-08T22:45:00-05:00")
        assert d == "2026-11-09"

    def test_normalize_naive_timestamp(self):
        """
        Naive timestamps are localized to Asia/Kolkata per historical convention.
        """
        dt, d = normalize_candle_timestamp("2025-01-01 09:15:00")
        assert d == "2025-01-01"
        assert str(dt.tzinfo) == "Asia/Kolkata"

    def test_normalize_date_only_string(self):
        """
        Date-only YYYY-MM-DD strings are preserved as the local session date.
        """
        _, d = normalize_candle_timestamp("2025-01-01")
        assert d == "2025-01-01"

    def test_malformed_timestamp_generates_exclusion(self):
        """
        Malformed or unparseable timestamps must be rejected with structured
        INVALID_TIMESTAMP_FORMAT exclusions without crashing or silent string chopping.
        """
        calendar = ["2025-01-01", "2025-01-02"]
        candles = [
            {"timestamp": "2025-01-01", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            {"timestamp": "totally-invalid-timestamp", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
            {"timestamp": "2025-01-02", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=calendar)

        # Check exclusion was properly recorded
        invalid_excls = [e for e in result.exclusions if e.reason == "INVALID_TIMESTAMP_FORMAT"]
        assert len(invalid_excls) == 1
        assert invalid_excls[0].signal_date == "totally-invalid-timestamp"
        assert "Malformed or unsupported timestamp format" in invalid_excls[0].details["error"]

        # Valid candles still produce target
        assert result.total_targets == 1
        df = result.to_dataframe()
        assert df.iloc[0]["signal_date"] == "2025-01-01"
        assert df.iloc[0]["entry_date"] == "2025-01-02"

    def test_mixed_timestamp_format_chronological_sorting(self):
        """
        Candles supplied out of order across diverse formats (UTC Z, IST +05:30, date-only)
        must be sorted by true instant rather than string comparison.
        """
        calendar = ["2025-01-01", "2025-01-02", "2025-01-03"]
        candles = [
            # Day 3 supplied first: 2025-01-03 date-only
            {"timestamp": "2025-01-03", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "volume": 100.0},
            # Day 1 supplied second: 2025-01-01T03:45:00Z (09:15 IST)
            {"timestamp": "2025-01-01T03:45:00Z", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 100.0},
            # Day 2 supplied third: 2025-01-01T18:30:00Z (which is 2025-01-02 00:00 IST!)
            {"timestamp": "2025-01-01T18:30:00Z", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "volume": 100.0},
        ]
        service = TargetService()
        result = service.generate(candles, symbol="TEST", horizons=[1], expected_sessions=calendar)

        assert result.total_targets == 2
        df = result.to_dataframe()
        assert df.iloc[0]["signal_date"] == "2025-01-01"
        assert df.iloc[0]["entry_date"] == "2025-01-02"
        assert df.iloc[1]["signal_date"] == "2025-01-02"
        assert df.iloc[1]["entry_date"] == "2025-01-03"


# =============================================================================
# L. Exchange-Specific Calendar Isolation Tests
# =============================================================================

class TestExchangeCalendarIsolation:
    def test_multi_exchange_flat_calendar_rejected(self):
        """
        When candles contain multiple distinct exchanges (e.g. NSE and BSE),
        passing a flat list for expected_sessions must raise ValueError.
        """
        candles_nse = [
            {"timestamp": "2025-01-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100, "exchange_id": "NSE", "stock_symbol": "RELIANCE"},
            {"timestamp": "2025-01-02", "open": 101, "high": 103, "low": 100, "close": 102, "volume": 100, "exchange_id": "NSE", "stock_symbol": "RELIANCE"},
        ]
        candles_bse = [
            {"timestamp": "2025-01-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100, "exchange_id": "BSE", "stock_symbol": "RELIANCE_BSE"},
            {"timestamp": "2025-01-02", "open": 101, "high": 103, "low": 100, "close": 102, "volume": 100, "exchange_id": "BSE", "stock_symbol": "RELIANCE_BSE"},
        ]
        combined = pd.DataFrame(candles_nse + candles_bse)

        service = TargetService()
        with pytest.raises(ValueError, match="Multiple distinct exchanges detected in candles dataset"):
            service.generate_multi_stock(
                combined,
                expected_sessions=["2025-01-01", "2025-01-02"],
            )

    def test_multi_exchange_separate_calendars_isolated(self):
        """
        When an exchange-mapped dictionary is provided ({'NSE': [...], 'BSE': [...]}),
        multi-stock generation cleanly processes both exchanges in full isolation.
        """
        cal_nse = ["2025-01-01", "2025-01-02", "2025-01-03"]
        cal_bse = ["2025-01-01", "2025-01-02", "2025-01-04"] # BSE has a holiday on Jan 03, trades on Jan 04

        candles_nse = [
            {"timestamp": "2025-01-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100, "exchange_id": "NSE", "stock_symbol": "TCS"},
            {"timestamp": "2025-01-02", "open": 101, "high": 103, "low": 100, "close": 102, "volume": 100, "exchange_id": "NSE", "stock_symbol": "TCS"},
            {"timestamp": "2025-01-03", "open": 102, "high": 104, "low": 101, "close": 103, "volume": 100, "exchange_id": "NSE", "stock_symbol": "TCS"},
        ]
        candles_bse = [
            {"timestamp": "2025-01-01", "open": 200, "high": 202, "low": 199, "close": 201, "volume": 100, "exchange_id": "BSE", "stock_symbol": "TCS_BSE"},
            {"timestamp": "2025-01-02", "open": 201, "high": 203, "low": 200, "close": 202, "volume": 100, "exchange_id": "BSE", "stock_symbol": "TCS_BSE"},
            {"timestamp": "2025-01-04", "open": 202, "high": 204, "low": 201, "close": 203, "volume": 100, "exchange_id": "BSE", "stock_symbol": "TCS_BSE"},
        ]
        combined = pd.DataFrame(candles_nse + candles_bse)

        service = TargetService()
        result = service.generate_multi_stock(
            combined,
            horizons=[1],
            expected_sessions={"NSE": cal_nse, "BSE": cal_bse},
        )

        df = result.to_dataframe()
        nse_rows = df[df["exchange_id"] == "NSE"]
        bse_rows = df[df["exchange_id"] == "BSE"]

        assert len(nse_rows) == 2
        assert len(bse_rows) == 2

        # NSE row 1 has signal on 2025-01-02 and entry on 2025-01-03
        assert nse_rows[nse_rows["signal_date"] == "2025-01-02"].iloc[0]["entry_date"] == "2025-01-03"

        # BSE row 1 has signal on 2025-01-02 and entry on 2025-01-04 (because BSE had holiday on Jan 03)
        assert bse_rows[bse_rows["signal_date"] == "2025-01-02"].iloc[0]["entry_date"] == "2025-01-04"

    def test_bse_calendar_does_not_affect_nse_indices(self):
        """
        Verifies that unexpected BSE schedule changes do not affect NSE candle target labels.
        """
        cal_nse = ["2025-01-01", "2025-01-02"]
        cal_bse = ["2025-01-01", "2025-01-05"] # Radical difference in BSE calendar

        candles_nse = [
            {"timestamp": "2025-01-01", "open": 100, "high": 102, "low": 99, "close": 101, "volume": 100, "exchange_id": "NSE", "stock_symbol": "INFY"},
            {"timestamp": "2025-01-02", "open": 102, "high": 104, "low": 101, "close": 103, "volume": 100, "exchange_id": "NSE", "stock_symbol": "INFY"},
        ]
        service = TargetService()
        result = service.generate_multi_stock(
            pd.DataFrame(candles_nse),
            horizons=[1],
            expected_sessions={"NSE": cal_nse, "BSE": cal_bse},
        )

        df = result.to_dataframe()
        assert len(df) == 1
        assert df.iloc[0]["entry_date"] == "2025-01-02"
