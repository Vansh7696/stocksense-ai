"""
StockSense AI — Executable Target-Label Generation Service
Calculates multi-horizon forward executable returns and 3-class target labels:
    R(t, h) = ((C[t+h] - O[t+1]) / O[t+1]) * 100

Execution proxy conventions:
- Prediction signal: Post session t close (using information through session t only).
- Entry proxy: Next trading session's opening auction clearing price O[t+1].
- Exit proxy: Horizon trading session's closing price C[t+h].
- Horizons: h in {1, 3, 5} trading sessions.

Classification rules:
- DOWN: return < -theta_h (class -1)
- NEUTRAL: -theta_h <= return <= +theta_h (class 0)
- UP: return > +theta_h (class +1)

Threshold configuration (centralized in app.config.target_settings):
- h=1: +/- 0.50%
- h=3: +/- 1.00%
- h=5: +/- 1.50%

All calculations use sequential trading-session indices, never calendar arithmetic.
Zero look-ahead bias: future prices are never used in feature computation.
"""

import math
import re
import zoneinfo
from datetime import datetime, date
from typing import Dict, Any, List, Optional, Tuple, Union
import numpy as np
import pandas as pd

from app.config import target_settings
from app.schemas.targets import (
    TargetClass,
    TargetType,
    TargetRecord,
    TargetExclusion,
    TargetThresholdConfig,
)
from app.schemas.market_data import CandleInput


def calculate_executable_return(entry_open: float, exit_close: float) -> float:
    """
    Computes percentage executable forward return:
        R(t, h) = ((C[t+h] - O[t+1]) / O[t+1]) * 100

    Args:
        entry_open: Next session's opening price O[t+1].
        exit_close: Horizon session's closing price C[t+h].

    Returns:
        float: Percentage return.

    Raises:
        ValueError: If prices are None, NaN, Infinite, or non-positive (<= 0).
    """
    if entry_open is None or exit_close is None:
        raise ValueError("Prices cannot be None for return calculation.")
    if math.isnan(entry_open) or math.isnan(exit_close):
        raise ValueError("Prices cannot be NaN for return calculation.")
    if math.isinf(entry_open) or math.isinf(exit_close):
        raise ValueError("Prices cannot be Infinite for return calculation.")
    if entry_open <= 0:
        raise ValueError(f"Entry open price must be strictly positive (> 0), got {entry_open}")
    if exit_close <= 0:
        raise ValueError(f"Exit close price must be strictly positive (> 0), got {exit_close}")

    return float(((exit_close - entry_open) / entry_open) * 100.0)


def calculate_close_to_close_return(signal_close: float, exit_close: float) -> float:
    """
    Computes theoretical close-to-close percentage return (academic diagnostic baseline):
        R_c2c(t, h) = ((C[t+h] - C[t]) / C[t]) * 100

    Args:
        signal_close: Signal session's closing price C[t].
        exit_close: Horizon session's closing price C[t+h].

    Returns:
        float: Percentage return.

    Raises:
        ValueError: If prices are None, NaN, Infinite, or non-positive (<= 0).
    """
    if signal_close is None or exit_close is None:
        raise ValueError("Prices cannot be None for return calculation.")
    if math.isnan(signal_close) or math.isnan(exit_close):
        raise ValueError("Prices cannot be NaN for return calculation.")
    if math.isinf(signal_close) or math.isinf(exit_close):
        raise ValueError("Prices cannot be Infinite for return calculation.")
    if signal_close <= 0:
        raise ValueError(f"Signal close price must be strictly positive (> 0), got {signal_close}")
    if exit_close <= 0:
        raise ValueError(f"Exit close price must be strictly positive (> 0), got {exit_close}")

    return float(((exit_close - signal_close) / signal_close) * 100.0)


def classify_target(
    return_pct: float,
    horizon: int,
    thresholds: Optional[Dict[int, float]] = None,
) -> Tuple[TargetClass, int]:
    """
    Assigns discrete 3-class target label based on return percentage and horizon threshold theta_h.

    Boundary conventions:
        - DOWN: return_pct < -theta_h          -> TargetClass.DOWN, -1
        - NEUTRAL: -theta_h <= return_pct <= +theta_h -> TargetClass.NEUTRAL, 0
        - UP: return_pct > +theta_h            -> TargetClass.UP, +1

    Args:
        return_pct: Return expressed as a percentage.
        horizon: Prediction horizon in trading sessions (e.g. 1, 3, 5).
        thresholds: Dictionary of {horizon: theta} thresholds. Defaults to centralized config.

    Returns:
        Tuple[TargetClass, int]: (TargetClass enum, integer label in {-1, 0, 1})

    Raises:
        ValueError: If return_pct is NaN/Inf, horizon is unconfigured, or theta <= 0.
    """
    if return_pct is None or math.isnan(return_pct) or math.isinf(return_pct):
        raise ValueError(f"Invalid return_pct value for classification: {return_pct}")

    if thresholds is None:
        thresholds = target_settings.thresholds

    if horizon not in thresholds:
        raise ValueError(f"Horizon {horizon} not configured in threshold dictionary: {thresholds}")

    theta = float(thresholds[horizon])
    if theta <= 0:
        raise ValueError(f"Threshold for horizon {horizon} must be strictly positive, got {theta}")

    # Boundary conditions: strictly less than -theta is DOWN, strictly greater than +theta is UP,
    # inclusive boundary [-theta, +theta] is NEUTRAL.
    if return_pct < -theta:
        return TargetClass.DOWN, -1
    elif return_pct > theta:
        return TargetClass.UP, 1
    else:
        return TargetClass.NEUTRAL, 0


class TargetGenerationResult:
    """
    Container for target generation output, containing both valid target records
    and detailed exclusion audit records.
    """

    def __init__(
        self,
        targets: List[TargetRecord],
        exclusions: List[TargetExclusion],
        symbol: str,
        stock_id: Optional[str] = None,
        exchange_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.targets = targets
        self.exclusions = exclusions
        self.symbol = symbol
        self.stock_id = stock_id
        self.exchange_id = exchange_id
        self.metadata = metadata or {}

    @property
    def total_targets(self) -> int:
        return len(self.targets)

    @property
    def total_exclusions(self) -> int:
        return len(self.exclusions)

    def to_dataframe(self) -> pd.DataFrame:
        """
        Converts generated target records into a clean pandas DataFrame.
        """
        if not self.targets:
            return pd.DataFrame(columns=[
                "stock_id",
                "exchange_id",
                "stock_symbol",
                "signal_session_index",
                "signal_date",
                "entry_session_index",
                "entry_date",
                "entry_open_price",
                "prediction_horizon",
                "exit_session_index",
                "exit_date",
                "exit_close_price",
                "executable_return_pct",
                "target_class",
                "target_label",
            ])

        records = []
        for t in self.targets:
            records.append({
                "stock_id": t.stock_id,
                "exchange_id": t.exchange_id,
                "stock_symbol": t.stock_symbol,
                "signal_session_index": t.signal_session_index,
                "signal_date": t.signal_date,
                "entry_session_index": t.entry_session_index,
                "entry_date": t.entry_date,
                "entry_open_price": t.entry_open_price,
                "prediction_horizon": t.prediction_horizon,
                "exit_session_index": t.exit_session_index,
                "exit_date": t.exit_date,
                "exit_close_price": t.exit_close_price,
                "executable_return_pct": t.executable_return_pct,
                "target_class": t.target_class.value if isinstance(t.target_class, TargetClass) else str(t.target_class),
                "target_label": t.target_label,
            })
        return pd.DataFrame(records)

    def exclusions_to_dataframe(self) -> pd.DataFrame:
        """
        Converts exclusion records into a pandas DataFrame.
        """
        if not self.exclusions:
            return pd.DataFrame(columns=[
                "stock_symbol",
                "signal_session_index",
                "signal_date",
                "prediction_horizon",
                "reason",
                "details",
            ])

        records = []
        for e in self.exclusions:
            records.append({
                "stock_symbol": e.stock_symbol,
                "signal_session_index": e.signal_session_index,
                "signal_date": e.signal_date,
                "prediction_horizon": e.prediction_horizon,
                "reason": e.reason,
                "details": str(e.details) if e.details else None,
            })
        return pd.DataFrame(records)


ISO_DATE_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KOLKATA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


def validate_expected_sessions(expected_sessions: Any) -> List[str]:
    """
    Validates that expected_sessions is a strictly chronological, non-empty list of
    valid, unique, exchange-local ISO YYYY-MM-DD date strings.

    Rejects:
    - Empty or non-list input.
    - Non-string entries or entries with leading/trailing whitespace.
    - Invalid formats (must strictly match YYYY-MM-DD).
    - Impossible calendar dates (e.g., 2025-02-31, 2025-13-40).
    - Duplicate session dates.
    - Unsorted / non-strictly ascending session dates.

    Returns:
        List of validated YYYY-MM-DD date strings.

    Raises:
        ValueError: If any structural, format, calendar, or ordering constraint is violated.
    """
    if expected_sessions is None:
        raise ValueError("expected_sessions cannot be None")

    if not isinstance(expected_sessions, (list, tuple)):
        raise ValueError(
            f"expected_sessions must be a list of YYYY-MM-DD strings, got {type(expected_sessions).__name__}"
        )

    if len(expected_sessions) == 0:
        raise ValueError("expected_sessions calendar cannot be empty")

    validated: List[str] = []
    seen = set()
    prev_date = None

    for i, item in enumerate(expected_sessions):
        if not isinstance(item, str):
            raise ValueError(
                f"expected_sessions[{i}] must be a string, got {type(item).__name__}: {item!r}"
            )

        # Reject whitespace-only or leading/trailing whitespace
        if item != item.strip() or not item.strip():
            raise ValueError(
                f"expected_sessions[{i}] contains invalid whitespace or is empty: {item!r}"
            )

        # Enforce strict ISO YYYY-MM-DD
        if not ISO_DATE_REGEX.match(item):
            raise ValueError(
                f"expected_sessions[{i}] does not match strict ISO 'YYYY-MM-DD' format: {item!r}"
            )

        # Validate actual calendar date validity (reject impossible dates)
        try:
            parsed_dt = datetime.strptime(item, "%Y-%m-%d").date()
        except ValueError as val_err:
            raise ValueError(
                f"expected_sessions[{i}] is an impossible or invalid calendar date: {item!r} ({val_err})"
            )

        # Reject duplicate session dates
        if item in seen:
            raise ValueError(
                f"expected_sessions contains duplicate session date at index {i}: {item!r}"
            )
        seen.add(item)

        # Reject unsorted / non-strictly ascending session dates
        if prev_date is not None:
            if parsed_dt <= prev_date:
                raise ValueError(
                    f"expected_sessions must be sorted in strictly ascending chronological order: "
                    f"index {i-1} ({prev_date.strftime('%Y-%m-%d')}) >= index {i} ({item})"
                )
        prev_date = parsed_dt
        validated.append(item)

    return validated


def normalize_candle_timestamp(ts: Any) -> Tuple[datetime, str]:
    """
    Parses and normalizes a candle timestamp into an Asia/Kolkata timezone-aware
    datetime object (for chronological sorting) and an exchange-local session date
    string 'YYYY-MM-DD'.

    Policy:
    - Date-only strings 'YYYY-MM-DD' represent local Asia/Kolkata exchange session dates.
    - Naive timestamps are localized to Asia/Kolkata per historical convention.
    - Timezone-aware timestamps (UTC, positive, negative offsets) are converted to Asia/Kolkata.
    - Equivalent instants (e.g., 2026-11-09T09:15:00+05:30 and 2026-11-09T03:45:00Z)
      resolve to the exact same Indian market session date (2026-11-09).
    - Late UTC timestamps (e.g., 2026-11-08T18:30:00Z) resolve to 2026-11-09 in Asia/Kolkata.
    - Malformed or unsupported formats raise ValueError (no silent string splitting).

    Returns:
        (aware_dt_kolkata, session_date_str_yyyy_mm_dd)
    """
    if ts is None:
        raise ValueError("Timestamp cannot be None")

    if isinstance(ts, (datetime, pd.Timestamp)):
        py_dt = ts.to_pydatetime() if isinstance(ts, pd.Timestamp) else ts
        if py_dt.tzinfo is None:
            aware_dt = py_dt.replace(tzinfo=KOLKATA_TZ)
        else:
            aware_dt = py_dt.astimezone(KOLKATA_TZ)
        return aware_dt, aware_dt.strftime("%Y-%m-%d")

    if not isinstance(ts, str):
        ts_str = str(ts).strip()
    else:
        ts_str = ts.strip()

    if not ts_str:
        raise ValueError("Empty or whitespace-only timestamp string")

    # 1. Date-only YYYY-MM-DD
    if ISO_DATE_REGEX.match(ts_str):
        try:
            d = datetime.strptime(ts_str, "%Y-%m-%d").date()
        except ValueError as err:
            raise ValueError(f"Invalid calendar date {ts_str!r}: {err}")
        aware_dt = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=KOLKATA_TZ)
        return aware_dt, ts_str

    # 2. Timezone-aware or naive ISO / datetime strings
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            aware_dt = dt.replace(tzinfo=KOLKATA_TZ)
        else:
            aware_dt = dt.astimezone(KOLKATA_TZ)
        return aware_dt, aware_dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass

    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d",
    ):
        try:
            dt = datetime.strptime(ts_str, fmt)
            if dt.tzinfo is None:
                aware_dt = dt.replace(tzinfo=KOLKATA_TZ)
            else:
                aware_dt = dt.astimezone(KOLKATA_TZ)
            return aware_dt, aware_dt.strftime("%Y-%m-%d")
        except ValueError:
            continue

    raise ValueError(f"Malformed or unsupported timestamp format: {ts!r}")


def _dates_match(d1: str, d2: str) -> bool:
    """
    Compares two timestamp or date strings by normalizing to Asia/Kolkata session dates.
    """
    if d1 == d2:
        return True
    try:
        _, s1 = normalize_candle_timestamp(d1)
    except Exception:
        s1 = str(d1).strip().split("T")[0]
    try:
        _, s2 = normalize_candle_timestamp(d2)
    except Exception:
        s2 = str(d2).strip().split("T")[0]
    return s1 == s2


def _build_session_index_map(expected_sessions: List[str]) -> Tuple[Dict[str, int], List[str]]:
    """
    Constructs index lookup map for session continuity validation after strictly
    validating calendar format, uniqueness, and chronological sort order.
    """
    validated = validate_expected_sessions(expected_sessions)
    mapping: Dict[str, int] = {d: i for i, d in enumerate(validated)}
    return mapping, validated


class TargetService:
    """
    Production target generation engine.
    Computes multi-horizon forward returns, assigns 3-class target labels,
    handles missing/invalid candle records with strict audit logging,
    and guarantees multi-stock and multi-exchange isolation.
    """

    def __init__(self, config: Optional[TargetThresholdConfig] = None):
        self.config = config or TargetThresholdConfig()

    def generate(
        self,
        candles: Union[List[Dict[str, Any]], List[CandleInput], pd.DataFrame],
        symbol: str = "UNKNOWN",
        stock_id: Optional[str] = None,
        exchange_id: Optional[str] = "NSE",
        horizons: Optional[List[int]] = None,
        target_type: Optional[Union[TargetType, str]] = None,
        thresholds: Optional[Dict[int, float]] = None,
        expected_sessions: Optional[List[str]] = None,
        validate_intermediate: bool = True,
        allow_unverified_session_sequence: bool = False,
    ) -> TargetGenerationResult:
        """
        Generates structured target records for a single stock and exchange series.

        Args:
            candles: Chronological OHLCV candles (DataFrame, list of dicts, or CandleInput).
            symbol: Equity ticker symbol.
            stock_id: Optional stock UUID.
            exchange_id: Optional exchange code (e.g. NSE).
            horizons: Prediction horizons in trading sessions (defaults to [1, 3, 5]).
            target_type: "open_to_close" (default / executable) or "close_to_close" (academic).
            thresholds: Optional threshold mapping overrides.
            expected_sessions: Explicitly verified list of all expected trading session dates in market calendar.
                               Required to verify trading session continuity and prevent silent session bridging.
            validate_intermediate: If True, checks that intermediate sessions exist and have valid prices.
            allow_unverified_session_sequence: Low-level internal test mode. If True, permits execution
                                               without an expected_sessions calendar. Default is False (fail closed).

        Returns:
            TargetGenerationResult containing valid target records, exclusion audit records, and metadata.

        Raises:
            ValueError: If expected_sessions is missing and allow_unverified_session_sequence is False.
        """
        # Fail closed: require expected_sessions unless explicit low-level test flag is provided
        if expected_sessions is None and not allow_unverified_session_sequence:
            raise ValueError(
                "An explicitly verified expected_sessions calendar is required to generate target labels "
                "safely and prevent silent trading session bridging. Set allow_unverified_session_sequence=True "
                "only for low-level internal unverified sequence testing."
            )

        # Determine horizons
        eval_horizons = horizons if horizons is not None else self.config.horizons
        if not eval_horizons:
            eval_horizons = list(target_settings.default_horizons)

        # Determine target type
        if target_type is None:
            t_type = self.config.target_type
        elif isinstance(target_type, str):
            t_type = TargetType(target_type)
        else:
            t_type = target_type

        # Determine thresholds
        eval_thresholds = thresholds if thresholds is not None else self.config.thresholds
        if eval_thresholds is None:
            eval_thresholds = dict(target_settings.thresholds)

        # Standardize candle DataFrame
        df, pre_exclusions = self._prepare_candles_df(candles, symbol=symbol)

        targets: List[TargetRecord] = []
        exclusions: List[TargetExclusion] = list(pre_exclusions)

        n = len(df)
        if n == 0:
            return TargetGenerationResult(
                targets=targets,
                exclusions=exclusions,
                symbol=symbol,
                stock_id=stock_id,
                exchange_id=exchange_id,
                metadata={
                    "total_candles_input": 0,
                    "valid_candles_count": 0,
                    "target_type": t_type.value,
                    "horizons": eval_horizons,
                    "unverified_session_sequence": expected_sessions is None,
                },
            )

        # Build expected session map if provided
        expected_session_indices = None
        expected_sessions_list = None
        if expected_sessions is not None:
            expected_session_indices, expected_sessions_list = _build_session_index_map(expected_sessions)

        # Iterate sequentially across trading session indices t
        for t in range(n):
            signal_date_str = str(df.iloc[t]["session_date"])
            signal_close = float(df.iloc[t]["close"])

            # Check if signal candle itself has valid close
            if math.isnan(signal_close) or signal_close <= 0:
                for h in eval_horizons:
                    exclusions.append(TargetExclusion(
                        stock_symbol=symbol,
                        signal_session_index=t,
                        signal_date=signal_date_str,
                        prediction_horizon=h,
                        reason="INVALID_SIGNAL_CANDLE_CLOSE",
                        details={"signal_close": signal_close},
                    ))
                continue

            sig_cal_idx = None
            if expected_session_indices is not None:
                sig_cal_idx = expected_session_indices.get(signal_date_str)

                if sig_cal_idx is None:
                    for h in eval_horizons:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="SIGNAL_DATE_NOT_IN_EXPECTED_CALENDAR",
                            details={"signal_date": signal_date_str},
                        ))
                    continue

            for h in eval_horizons:
                if t_type == TargetType.OPEN_TO_CLOSE:
                    entry_idx = t + 1
                else:  # close_to_close
                    entry_idx = t

                exit_idx = t + h

                # 1. Check entry session existence & calendar continuity
                if expected_session_indices is not None:
                    exp_ent_cal_idx = sig_cal_idx + 1 if t_type == TargetType.OPEN_TO_CLOSE else sig_cal_idx
                    if exp_ent_cal_idx >= len(expected_sessions_list):
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_ENTRY_TRADING_SESSION",
                            details={"expected_calendar_index": exp_ent_cal_idx, "calendar_size": len(expected_sessions_list)},
                        ))
                        continue
                    exp_ent_date = expected_sessions_list[exp_ent_cal_idx]

                    if entry_idx >= n:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_ENTRY_CANDLE",
                            details={"entry_session_index": entry_idx, "available_candles": n, "expected_date": exp_ent_date},
                        ))
                        continue

                    actual_entry_date = str(df.iloc[entry_idx]["session_date"])
                    if actual_entry_date != exp_ent_date:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_ENTRY_TRADING_SESSION",
                            details={
                                "expected_entry_index": exp_ent_cal_idx,
                                "expected_entry_date": exp_ent_date,
                                "actual_entry_date": actual_entry_date,
                            },
                        ))
                        continue
                else:
                    if entry_idx >= n:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_ENTRY_CANDLE",
                            details={"entry_session_index": entry_idx, "available_candles": n},
                        ))
                        continue

                # 2. Check intermediate expected session continuity (between entry and exit)
                if expected_session_indices is not None:
                    start_inter_offset = 2 if t_type == TargetType.OPEN_TO_CLOSE else 1
                    if h > start_inter_offset:
                        has_missing_intermediate = False
                        for step_offset in range(start_inter_offset, h):
                            step_cal_idx = sig_cal_idx + step_offset
                            step_candle_idx = t + step_offset
                            if step_cal_idx >= len(expected_sessions_list):
                                exclusions.append(TargetExclusion(
                                    stock_symbol=symbol,
                                    signal_session_index=t,
                                    signal_date=signal_date_str,
                                    prediction_horizon=h,
                                    reason="MISSING_INTERMEDIATE_TRADING_SESSION",
                                    details={
                                        "missing_offset": step_offset,
                                        "expected_calendar_index": step_cal_idx,
                                        "calendar_size": len(expected_sessions_list),
                                    },
                                ))
                                has_missing_intermediate = True
                                break
                            exp_step_date = expected_sessions_list[step_cal_idx]
                            actual_step_date = str(df.iloc[step_candle_idx]["session_date"]) if step_candle_idx < n else None
                            if step_candle_idx >= n or actual_step_date != exp_step_date:
                                exclusions.append(TargetExclusion(
                                    stock_symbol=symbol,
                                    signal_session_index=t,
                                    signal_date=signal_date_str,
                                    prediction_horizon=h,
                                    reason="MISSING_INTERMEDIATE_TRADING_SESSION",
                                    details={
                                        "missing_offset": step_offset,
                                        "expected_date": exp_step_date,
                                        "actual_date": actual_step_date,
                                    },
                                ))
                                has_missing_intermediate = True
                                break
                        if has_missing_intermediate:
                            continue

                # 3. Check exit session existence & calendar continuity
                if expected_session_indices is not None:
                    exp_ext_cal_idx = sig_cal_idx + h
                    if exp_ext_cal_idx >= len(expected_sessions_list):
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_EXIT_TRADING_SESSION",
                            details={"expected_calendar_index": exp_ext_cal_idx, "calendar_size": len(expected_sessions_list)},
                        ))
                        continue
                    exp_ext_date = expected_sessions_list[exp_ext_cal_idx]

                    if exit_idx >= n:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_EXIT_CANDLE",
                            details={"exit_session_index": exit_idx, "available_candles": n, "expected_date": exp_ext_date},
                        ))
                        continue

                    actual_exit_date = str(df.iloc[exit_idx]["session_date"])
                    if actual_exit_date != exp_ext_date:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_EXIT_TRADING_SESSION",
                            details={
                                "expected_exit_index": exp_ext_cal_idx,
                                "expected_exit_date": exp_ext_date,
                                "actual_exit_date": actual_exit_date,
                            },
                        ))
                        continue
                else:
                    if exit_idx >= n:
                        exclusions.append(TargetExclusion(
                            stock_symbol=symbol,
                            signal_session_index=t,
                            signal_date=signal_date_str,
                            prediction_horizon=h,
                            reason="MISSING_EXIT_CANDLE",
                            details={"exit_session_index": exit_idx, "available_candles": n},
                        ))
                        continue

                entry_date_str = str(df.iloc[entry_idx]["session_date"])
                exit_date_str = str(df.iloc[exit_idx]["session_date"])

                # 4. Check intermediate session data validity
                if validate_intermediate and exit_idx >= entry_idx:
                    has_invalid_intermediate = False
                    for inter_idx in range(entry_idx, exit_idx + 1):
                        inter_op = float(df.iloc[inter_idx]["open"])
                        inter_hi = float(df.iloc[inter_idx]["high"])
                        inter_lo = float(df.iloc[inter_idx]["low"])
                        inter_cl = float(df.iloc[inter_idx]["close"])
                        inter_vo = float(df.iloc[inter_idx]["volume"])

                        if (
                            math.isnan(inter_op) or math.isnan(inter_hi) or math.isnan(inter_lo) or math.isnan(inter_cl) or math.isnan(inter_vo)
                            or math.isinf(inter_op) or math.isinf(inter_hi) or math.isinf(inter_lo) or math.isinf(inter_cl) or math.isinf(inter_vo)
                            or inter_op <= 0 or inter_hi <= 0 or inter_lo <= 0 or inter_cl <= 0 or inter_vo < 0
                            or inter_hi < inter_lo
                            or inter_hi < inter_op
                            or inter_hi < inter_cl
                            or inter_lo > inter_op
                            or inter_lo > inter_cl
                        ):
                            exclusions.append(TargetExclusion(
                                stock_symbol=symbol,
                                signal_session_index=t,
                                signal_date=signal_date_str,
                                prediction_horizon=h,
                                reason="INVALID_INTERMEDIATE_SESSION_PRICES",
                                details={
                                    "intermediate_index": inter_idx,
                                    "date": str(df.iloc[inter_idx]["timestamp"]),
                                    "open": inter_op,
                                    "high": inter_hi,
                                    "low": inter_lo,
                                    "close": inter_cl,
                                    "volume": inter_vo,
                                },
                            ))
                            has_invalid_intermediate = True
                            break
                    if has_invalid_intermediate:
                        continue

                # 5. Retrieve entry and exit prices
                if t_type == TargetType.OPEN_TO_CLOSE:
                    entry_price = float(df.iloc[entry_idx]["open"])
                else:
                    entry_price = float(df.iloc[entry_idx]["close"])

                exit_price = float(df.iloc[exit_idx]["close"])

                # 6. Validate price numerical validity
                if math.isnan(entry_price) or math.isinf(entry_price) or entry_price <= 0:
                    exclusions.append(TargetExclusion(
                        stock_symbol=symbol,
                        signal_session_index=t,
                        signal_date=signal_date_str,
                        prediction_horizon=h,
                        reason="NON_POSITIVE_OR_INVALID_ENTRY_PRICE",
                        details={"entry_price": entry_price},
                    ))
                    continue

                if math.isnan(exit_price) or math.isinf(exit_price) or exit_price <= 0:
                    exclusions.append(TargetExclusion(
                        stock_symbol=symbol,
                        signal_session_index=t,
                        signal_date=signal_date_str,
                        prediction_horizon=h,
                        reason="NON_POSITIVE_OR_INVALID_EXIT_PRICE",
                        details={"exit_price": exit_price},
                    ))
                    continue

                # 7. Compute executable return percentage
                return_pct = ((exit_price - entry_price) / entry_price) * 100.0

                # 8. Classify return
                try:
                    target_class, target_label = classify_target(
                        return_pct=return_pct,
                        horizon=h,
                        thresholds=eval_thresholds,
                    )
                except ValueError as err:
                    exclusions.append(TargetExclusion(
                        stock_symbol=symbol,
                        signal_session_index=t,
                        signal_date=signal_date_str,
                        prediction_horizon=h,
                        reason="CLASSIFICATION_ERROR",
                        details={"error": str(err)},
                    ))
                    continue

                # 9. Create valid target record
                record = TargetRecord(
                    stock_id=stock_id,
                    exchange_id=exchange_id,
                    stock_symbol=symbol,
                    signal_session_index=t,
                    signal_date=signal_date_str,
                    entry_session_index=entry_idx,
                    entry_date=entry_date_str,
                    entry_open_price=round(entry_price, 4),
                    prediction_horizon=h,
                    exit_session_index=exit_idx,
                    exit_date=exit_date_str,
                    exit_close_price=round(exit_price, 4),
                    executable_return_pct=round(return_pct, 5),
                    target_class=target_class,
                    target_label=target_label,
                )
                targets.append(record)

        metadata = {
            "symbol": symbol,
            "stock_id": stock_id,
            "exchange_id": exchange_id,
            "total_candles_input": len(candles) if isinstance(candles, list) else len(candles),
            "valid_candles_count": n,
            "total_signals_evaluated": n,
            "total_targets_generated": len(targets),
            "total_exclusions": len(exclusions),
            "target_type": t_type.value,
            "horizons": eval_horizons,
            "thresholds": eval_thresholds,
            "unverified_session_sequence": expected_sessions is None,
        }

        return TargetGenerationResult(
            targets=targets,
            exclusions=exclusions,
            symbol=symbol,
            stock_id=stock_id,
            exchange_id=exchange_id,
            metadata=metadata,
        )

    def generate_dataframe(
        self,
        candles: Union[List[Dict[str, Any]], List[CandleInput], pd.DataFrame],
        symbol: str = "UNKNOWN",
        stock_id: Optional[str] = None,
        exchange_id: Optional[str] = "NSE",
        horizons: Optional[List[int]] = None,
        target_type: Optional[Union[TargetType, str]] = None,
        thresholds: Optional[Dict[int, float]] = None,
        expected_sessions: Optional[List[str]] = None,
        validate_intermediate: bool = True,
        allow_unverified_session_sequence: bool = False,
    ) -> pd.DataFrame:
        """
        Convenience wrapper returning pandas DataFrame directly.
        """
        result = self.generate(
            candles=candles,
            symbol=symbol,
            stock_id=stock_id,
            exchange_id=exchange_id,
            horizons=horizons,
            target_type=target_type,
            thresholds=thresholds,
            expected_sessions=expected_sessions,
            validate_intermediate=validate_intermediate,
            allow_unverified_session_sequence=allow_unverified_session_sequence,
        )
        return result.to_dataframe()

    def generate_multi_stock(
        self,
        candles_by_stock: Union[List[Dict[str, Any]], pd.DataFrame],
        horizons: Optional[List[int]] = None,
        target_type: Optional[Union[TargetType, str]] = None,
        thresholds: Optional[Dict[int, float]] = None,
        expected_sessions: Optional[Union[List[str], Dict[str, List[str]]]] = None,
        allow_unverified_session_sequence: bool = False,
    ) -> TargetGenerationResult:
        """
        Processes multi-stock and multi-exchange candlestick datasets while guaranteeing
        strict isolation.

        Enforces:
        - NSE and BSE series for the same symbol are partitioned into completely separate groups.
        - Stocks never share candle sequences or intermediate sessions.
        - Group order and output are strictly deterministic.

        Args:
            candles_by_stock: Collection of candle records with 'symbol' (or 'stock_symbol')
                              and optionally 'exchange_id'/'exchange_code' and 'stock_id'.
            horizons: Target horizons.
            target_type: Target calculation type.
            thresholds: Threshold mapping.
            expected_sessions: Explicitly verified list of sessions, or dict mapping exchange/symbol to sessions.
            allow_unverified_session_sequence: Low-level internal test mode.

        Returns:
            TargetGenerationResult containing pooled targets and exclusions.
        """
        if isinstance(candles_by_stock, pd.DataFrame):
            df_all = candles_by_stock.copy()
        else:
            df_all = pd.DataFrame([
                c if isinstance(c, dict) else c.model_dump() for c in candles_by_stock
            ])

        if len(df_all) == 0:
            return TargetGenerationResult(
                targets=[],
                exclusions=[],
                symbol="POOLED",
                metadata={"total_groups": 0, "total_targets": 0},
            )

        # Standardize group identifier columns
        symbol_col = "stock_symbol" if "stock_symbol" in df_all.columns else "symbol"
        if symbol_col not in df_all.columns:
            df_all[symbol_col] = "UNKNOWN"

        exchange_col = "exchange_id" if "exchange_id" in df_all.columns else "exchange_code"
        if exchange_col not in df_all.columns:
            exchange_col = "exchange" if "exchange" in df_all.columns else None

        if exchange_col is None:
            df_all["exchange_id"] = "NSE"
            exchange_col = "exchange_id"
        else:
            df_all[exchange_col] = df_all[exchange_col].astype(str).str.strip().str.upper()

        distinct_exchanges = set(df_all[exchange_col].dropna().unique().tolist())
        if len(distinct_exchanges) > 1 and not allow_unverified_session_sequence:
            if not isinstance(expected_sessions, dict):
                raise ValueError(
                    f"Multiple distinct exchanges detected in candles dataset: {sorted(distinct_exchanges)}. "
                    "A single flat expected_sessions list cannot be shared across multiple exchanges. "
                    "Provide an exchange-specific mapping dict (e.g. {'NSE': [...], 'BSE': [...]}) "
                    "to enforce calendar isolation."
                )

        stock_id_col = "stock_id" if "stock_id" in df_all.columns else None

        group_cols = [symbol_col, exchange_col]
        if stock_id_col:
            group_cols.append(stock_id_col)

        # Sort group keys deterministically
        grouped = df_all.groupby(group_cols, sort=True)

        all_targets: List[TargetRecord] = []
        all_exclusions: List[TargetExclusion] = []

        for group_keys, group_df in grouped:
            if isinstance(group_keys, tuple):
                sym = str(group_keys[0])
                exch = str(group_keys[1])
                stk_id = str(group_keys[2]) if len(group_keys) > 2 else None
            else:
                sym = str(group_keys)
                exch = "NSE"
                stk_id = None

            # Determine expected_sessions for this group
            group_sessions = None
            if isinstance(expected_sessions, dict):
                group_sessions = (
                    expected_sessions.get(f"{sym}_{exch}")
                    or expected_sessions.get(f"{exch}_{sym}")
                    or expected_sessions.get(exch)
                    or expected_sessions.get(sym)
                )
                if group_sessions is None and not allow_unverified_session_sequence:
                    raise ValueError(
                        f"Missing expected_sessions calendar mapping for exchange '{exch}' "
                        f"(group: symbol='{sym}', exchange='{exch}'). "
                        "Every exchange in multi-exchange dataset must have an explicit calendar."
                    )
            elif isinstance(expected_sessions, list):
                group_sessions = expected_sessions

            group_result = self.generate(
                candles=group_df,
                symbol=sym,
                stock_id=stk_id,
                exchange_id=exch,
                horizons=horizons,
                target_type=target_type,
                thresholds=thresholds,
                expected_sessions=group_sessions,
                allow_unverified_session_sequence=allow_unverified_session_sequence,
            )
            all_targets.extend(group_result.targets)
            all_exclusions.extend(group_result.exclusions)

        return TargetGenerationResult(
            targets=all_targets,
            exclusions=all_exclusions,
            symbol="POOLED",
            metadata={
                "total_groups": len(grouped),
                "total_targets": len(all_targets),
                "total_exclusions": len(all_exclusions),
            },
        )

    def _prepare_candles_df(
        self,
        candles: Union[List[Dict[str, Any]], List[CandleInput], pd.DataFrame],
        symbol: str,
    ) -> Tuple[pd.DataFrame, List[TargetExclusion]]:
        """
        Validates, cleans, sorts chronologically, and deduplicates candles.
        Enforces comprehensive OHLCV relationship and geometry checks.
        Records audit exclusions for dropped or invalid rows.
        """
        exclusions: List[TargetExclusion] = []

        if isinstance(candles, pd.DataFrame):
            df = candles.copy()
        else:
            df = pd.DataFrame([
                c if isinstance(c, dict) else c.model_dump() for c in candles
            ])

        if len(df) == 0:
            return pd.DataFrame(), exclusions

        # Ensure required OHLCV columns exist
        required_cols = ["timestamp", "open", "high", "low", "close", "volume"]
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required OHLCV columns: {missing}")

        clean_rows = []
        for i, row in df.iterrows():
            raw_ts = row["timestamp"]

            # Check for null or empty timestamp
            if pd.isna(raw_ts) or raw_ts is None or str(raw_ts).strip() in ("", "None", "nan"):
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date="UNKNOWN",
                    prediction_horizon=0,
                    reason="DROPPED_NULL_TIMESTAMP",
                ))
                continue

            # Parse and normalize timestamp to Asia/Kolkata
            try:
                aware_dt, session_date_str = normalize_candle_timestamp(raw_ts)
            except ValueError as ts_err:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=str(raw_ts),
                    prediction_horizon=0,
                    reason="INVALID_TIMESTAMP_FORMAT",
                    details={"error": str(ts_err)},
                ))
                continue

            # Validate numeric OHLCV sanity & geometry
            try:
                op = float(row["open"])
                hi = float(row["high"])
                lo = float(row["low"])
                cl = float(row["close"])
                vo = float(row["volume"])
            except (ValueError, TypeError) as conv_err:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="NON_NUMERIC_OHLCV_VALUE",
                    details={"error": str(conv_err)},
                ))
                continue

            if math.isnan(op) or math.isnan(hi) or math.isnan(lo) or math.isnan(cl) or math.isnan(vo):
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="NAN_OHLCV_VALUE",
                    details={"open": op, "high": hi, "low": lo, "close": cl, "volume": vo},
                ))
                continue

            if math.isinf(op) or math.isinf(hi) or math.isinf(lo) or math.isinf(cl) or math.isinf(vo):
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INFINITE_OHLCV_VALUE",
                    details={"open": op, "high": hi, "low": lo, "close": cl, "volume": vo},
                ))
                continue

            # Volume must be non-negative
            if vo < 0:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="NEGATIVE_VOLUME",
                    details={"volume": vo},
                ))
                continue

            # Prices must be strictly positive
            if op <= 0 or hi <= 0 or lo <= 0 or cl <= 0:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="NON_POSITIVE_OHLCV_PRICE",
                    details={"open": op, "high": hi, "low": lo, "close": cl},
                ))
                continue

            # Candlestick geometry checks
            if hi < lo:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INVALID_BAR_HIGH_LT_LOW",
                    details={"high": hi, "low": lo},
                ))
                continue

            if hi < op:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INVALID_BAR_HIGH_LT_OPEN",
                    details={"high": hi, "open": op},
                ))
                continue

            if hi < cl:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INVALID_BAR_HIGH_LT_CLOSE",
                    details={"high": hi, "close": cl},
                ))
                continue

            if lo > op:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INVALID_BAR_LOW_GT_OPEN",
                    details={"low": lo, "open": op},
                ))
                continue

            if lo > cl:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=int(i),
                    signal_date=session_date_str,
                    prediction_horizon=0,
                    reason="INVALID_BAR_LOW_GT_CLOSE",
                    details={"low": lo, "close": cl},
                ))
                continue

            clean_rows.append({
                "timestamp": str(raw_ts),
                "session_date": session_date_str,
                "_sort_dt": aware_dt,
                "open": op,
                "high": hi,
                "low": lo,
                "close": cl,
                "volume": vo,
            })

        if not clean_rows:
            return pd.DataFrame(), exclusions

        clean_df = pd.DataFrame(clean_rows)

        # Sort strictly ascending by actual chronological datetime
        clean_df = clean_df.sort_values("_sort_dt", ascending=True).reset_index(drop=True)

        # Check and handle duplicate session dates (keep last)
        duplicates = clean_df.duplicated(subset=["session_date"], keep="last")
        if duplicates.any():
            dup_dates = clean_df[duplicates]["session_date"].tolist()
            for d in dup_dates:
                exclusions.append(TargetExclusion(
                    stock_symbol=symbol,
                    signal_session_index=-1,
                    signal_date=str(d),
                    prediction_horizon=0,
                    reason="DEDUPLICATED_TIMESTAMP_KEEP_LAST",
                ))
            clean_df = clean_df.drop_duplicates(subset=["session_date"], keep="last").reset_index(drop=True)

        return clean_df, exclusions


def generate_targets(
    df: pd.DataFrame,
    horizons: List[int] = [1, 3, 5],
    target_type: str = "open_to_close",
    thetas: Optional[Dict[int, float]] = None,
    symbol: str = "UNKNOWN",
    stock_id: Optional[str] = None,
    exchange_id: Optional[str] = "NSE",
    expected_sessions: Optional[List[str]] = None,
    allow_unverified_session_sequence: bool = False,
) -> pd.DataFrame:
    """
    Standard target generator function matching Addendum Section 6.4 interface.

    Returns:
        pd.DataFrame containing executable or close-to-close targets across requested horizons.
    """
    thresholds = thetas if thetas is not None else dict(target_settings.thresholds)
    service = TargetService(
        TargetThresholdConfig(
            horizons=horizons,
            thresholds=thresholds,
            target_type=TargetType(target_type),
        )
    )
    return service.generate_dataframe(
        candles=df,
        symbol=symbol,
        stock_id=stock_id,
        exchange_id=exchange_id,
        horizons=horizons,
        target_type=target_type,
        thresholds=thresholds,
        expected_sessions=expected_sessions,
        allow_unverified_session_sequence=allow_unverified_session_sequence,
    )
