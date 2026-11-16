"""
StockSense AI — Purged Grouped Chronological Splitting Service
Implements mathematically rigorous chronological train/val/test splitting
with boundary purging to eliminate forward target label leakage across partitions,
cross-sectional date grouping across all equities, and strict scaler quarantine.
"""

import math
from typing import Dict, Any, List, Optional, Tuple, Union, Set
import numpy as np
import pandas as pd

from app.config import validation_settings, target_settings
from app.schemas.splitting import (
    SplitPartition,
    SplitConfig,
    PartitionBoundary,
    HorizonPurgeAccounting,
    SplitDataBundle,
    PurgedSplitResult,
)
from app.services.targets import normalize_candle_timestamp


# Explicit list of columns that must NEVER be present in feature matrix X
FUTURE_OR_TARGET_DERIVED_COLUMNS: Set[str] = {
    "target_class",
    "target_label",
    "executable_return_pct",
    "close_to_close_return_pct",
    "entry_open_price",
    "exit_close_price",
    "entry_date",
    "exit_date",
    "entry_session_index",
    "exit_session_index",
    "signal_session_index",
}

# Strict allowlist of the 23 approved engineered features from Phase 5B
APPROVED_FEATURE_ALLOWLIST: Tuple[str, ...] = (
    "price_to_sma20",
    "price_to_sma50",
    "price_to_sma200",
    "price_to_ema12",
    "price_to_ema26",
    "price_to_ema50",
    "rsi_14",
    "rsi_normalized",
    "rsi_slope_5",
    "macd_hist",
    "macd_hist_normalized",
    "bb_percent_b",
    "bb_zscore",
    "bb_bandwidth",
    "atr_pct",
    "return_1d",
    "return_5d",
    "return_21d",
    "volatility_20d",
    "relative_volume_20",
    "trend_alignment",
    "ma_spread_50_200",
    "ma_spread_20_50",
)


class StandardScaler:
    """
    Scale-invariant z-score feature standardizer.
    Compatible with scikit-learn StandardScaler specification:
    - Uses population standard deviation: ddof=0
    - Safely handles zero-variance / constant features by setting scale_ = 1.0
    - Prevents data leakage by fitting strictly on training data
    """

    def __init__(self, with_mean: bool = True, with_std: bool = True):
        self.with_mean = with_mean
        self.with_std = with_std
        self.mean_: Optional[np.ndarray] = None
        self.var_: Optional[np.ndarray] = None
        self.scale_: Optional[np.ndarray] = None
        self.n_features_in_: Optional[int] = None
        self.feature_names_in_: Optional[List[str]] = None

    def fit(self, X: Union[pd.DataFrame, np.ndarray], y: Any = None) -> "StandardScaler":
        """
        Computes the mean and population standard deviation (ddof=0) strictly on X_train.
        """
        if isinstance(X, pd.DataFrame):
            self.feature_names_in_ = list(X.columns)
            arr = X.to_numpy(dtype=float)
        else:
            self.feature_names_in_ = None
            arr = np.asarray(X, dtype=float)

        if arr.size == 0 or arr.ndim != 2:
            raise ValueError(f"Input X must be a 2D array, got shape {arr.shape}")

        self.n_features_in_ = arr.shape[1]
        self.mean_ = np.mean(arr, axis=0)
        self.var_ = np.var(arr, axis=0, ddof=0)

        # Population standard deviation (ddof=0)
        scale = np.sqrt(self.var_)

        # Handle constant features: if std == 0, scale_ = 1.0 (matching scikit-learn behavior)
        constant_mask = (scale == 0.0) | np.isnan(scale)
        scale[constant_mask] = 1.0
        self.scale_ = scale

        return self

    def transform(self, X: Union[pd.DataFrame, np.ndarray]) -> Union[pd.DataFrame, np.ndarray]:
        """
        Standardizes X using parameters learned strictly during fit().
        Never updates mean_ or scale_ from evaluation data.
        """
        if self.mean_ is None or self.scale_ is None:
            raise ValueError("StandardScaler instance is not fitted yet. Call 'fit' before using transform().")

        is_df = isinstance(X, pd.DataFrame)
        if is_df:
            arr = X.to_numpy(dtype=float)
        else:
            arr = np.asarray(X, dtype=float)

        if arr.shape[1] != self.n_features_in_:
            raise ValueError(
                f"Feature dimension mismatch: expected {self.n_features_in_} features, got {arr.shape[1]}"
            )

        scaled = arr.copy()
        if self.with_mean:
            scaled = scaled - self.mean_
        if self.with_std:
            scaled = scaled / self.scale_

        if is_df:
            return pd.DataFrame(scaled, index=X.index, columns=X.columns)
        return scaled

    def fit_transform(self, X: Union[pd.DataFrame, np.ndarray], y: Any = None) -> Union[pd.DataFrame, np.ndarray]:
        return self.fit(X, y).transform(X)


class PurgedChronologicalSplitter:
    """
    Purged Grouped Chronological Splitting Engine.
    Partitions chronological equity data across Train, Validation, and Held-Out Test sets:
    1. Cross-Sectional Grouping: All equities on any calendar date D_k reside in the exact same partition.
    2. Boundary Purging: For horizon h, discards the final h sample dates of Train and Validation
       to guarantee zero target label overlap into subsequent partitions.
    3. Scaler Quarantine: Fits feature standardizer strictly on retained X_train.
    """

    def __init__(self, config: Optional[SplitConfig] = None):
        self.config = config or SplitConfig()

    def split_calendar_dates(
        self,
        clean_dates: List[str],
    ) -> Dict[SplitPartition, List[str]]:
        """
        Partitions unique aligned calendar date strings strictly chronologically
        into Train, Validation, and Held-Out Test nominal partitions.
        """
        if not clean_dates:
            raise ValueError("clean_dates list cannot be empty")

        # Ensure dates are unique, strictly formatted, and sorted
        normalized_dates = []
        seen = set()
        for d in clean_dates:
            _, s_date = normalize_candle_timestamp(d)
            if s_date in seen:
                continue
            seen.add(s_date)
            normalized_dates.append(s_date)

        n_dates = len(normalized_dates)
        if n_dates < 10:
            raise ValueError(f"Insufficient distinct calendar dates ({n_dates}) to construct meaningful partitions.")

        # Compute nominal integer cutoffs (Option A baseline: 70% floor gives 380 / 81 / 83 for 544 clean dates)
        train_count = int(n_dates * self.config.train_ratio)
        val_count = int(n_dates * self.config.val_ratio)
        test_count = n_dates - (train_count + val_count)

        if test_count <= 0:
            test_count = 1
            if val_count > 1:
                val_count -= 1
            else:
                train_count -= 1

        train_dates = normalized_dates[:train_count]
        val_dates = normalized_dates[train_count : train_count + val_count]
        test_dates = normalized_dates[train_count + val_count :]

        return {
            SplitPartition.TRAIN: train_dates,
            SplitPartition.VAL: val_dates,
            SplitPartition.TEST: test_dates,
        }

    def get_partition_boundaries(
        self,
        clean_dates: List[str],
    ) -> Dict[str, PartitionBoundary]:
        """
        Returns formal boundary descriptors for nominal partitions.
        """
        date_splits = self.split_calendar_dates(clean_dates)
        boundaries: Dict[str, PartitionBoundary] = {}

        current_idx = 0
        for part in [SplitPartition.TRAIN, SplitPartition.VAL, SplitPartition.TEST]:
            p_dates = date_splits[part]
            start_idx = current_idx
            end_idx = current_idx + len(p_dates) - 1
            current_idx += len(p_dates)

            boundaries[part.value] = PartitionBoundary(
                name=part,
                nominal_dates_count=len(p_dates),
                start_date=p_dates[0],
                end_date=p_dates[-1],
                start_index=start_idx,
                end_index=end_idx,
            )

        return boundaries

    def split_target_dataset(
        self,
        targets_df: pd.DataFrame,
        clean_dates: List[str],
        horizon: int,
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, HorizonPurgeAccounting]:
        """
        Partitions target records for a specific horizon h into:
        (retained_train_df, retained_val_df, retained_test_df, purged_df, accounting).
        """
        if "prediction_horizon" not in targets_df.columns:
            raise ValueError("targets_df must contain 'prediction_horizon' column")

        # Filter strictly for the requested horizon (Horizon Isolation)
        df_h = targets_df[targets_df["prediction_horizon"] == horizon].copy()
        if len(df_h) == 0:
            raise ValueError(f"No target records found for requested horizon h={horizon}")

        date_col = "session_date" if "session_date" in df_h.columns else "signal_date"
        if date_col not in df_h.columns:
            raise ValueError("targets_df must contain 'signal_date' or 'session_date'")

        # Ensure session dates are canonical YYYY-MM-DD
        df_h["session_date"] = df_h[date_col].apply(lambda x: normalize_candle_timestamp(x)[1])

        # Enforce uniqueness of (stock_symbol, session_date) for this horizon
        symbol_col = "stock_symbol" if "stock_symbol" in df_h.columns else "symbol"
        if symbol_col not in df_h.columns:
            df_h[symbol_col] = "UNKNOWN"

        dupes = df_h.duplicated(subset=[symbol_col, "session_date"])
        if dupes.any():
            sample_dupes = df_h[dupes][[symbol_col, "session_date"]].head(3).to_dict(orient="records")
            raise ValueError(
                f"Duplicate target keys detected for horizon h={horizon} on [{symbol_col}, 'session_date']: {sample_dupes}"
            )

        # Get nominal partition dates
        date_splits = self.split_calendar_dates(clean_dates)
        train_dates_all = date_splits[SplitPartition.TRAIN]
        val_dates_all = date_splits[SplitPartition.VAL]
        test_dates_all = date_splits[SplitPartition.TEST]

        # 1. Train Partition & Boundary Purge:
        # Purge the final h sample dates of Train
        purged_train_dates = train_dates_all[-horizon:] if horizon <= len(train_dates_all) else list(train_dates_all)
        retained_train_dates = train_dates_all[:-horizon] if horizon <= len(train_dates_all) else []

        # 2. Validation Partition & Boundary Purge:
        # Purge the final h sample dates of Val
        purged_val_dates = val_dates_all[-horizon:] if horizon <= len(val_dates_all) else list(val_dates_all)
        retained_val_dates = val_dates_all[:-horizon] if horizon <= len(val_dates_all) else []

        # Optional embargo on subsequent partitions (if embargo_dates > 0)
        embargo = self.config.embargo_dates
        if embargo > 0:
            if embargo < len(retained_val_dates):
                # Blackout first E dates of validation
                retained_val_dates = retained_val_dates[embargo:]
            else:
                retained_val_dates = []

            if embargo < len(test_dates_all):
                # Blackout first E dates of test
                retained_test_dates = test_dates_all[embargo:]
            else:
                retained_test_dates = []
        else:
            retained_test_dates = list(test_dates_all)

        # Segment rows into partitions
        retained_train_set = set(retained_train_dates)
        retained_val_set = set(retained_val_dates)
        retained_test_set = set(retained_test_dates)
        purged_dates_set = set(purged_train_dates) | set(purged_val_dates)

        train_mask = df_h["session_date"].isin(retained_train_set)
        val_mask = df_h["session_date"].isin(retained_val_set)
        test_mask = df_h["session_date"].isin(retained_test_set)
        purged_mask = df_h["session_date"].isin(purged_dates_set)

        train_df = df_h[train_mask].sort_values([symbol_col, "session_date"]).reset_index(drop=True)
        val_df = df_h[val_mask].sort_values([symbol_col, "session_date"]).reset_index(drop=True)
        test_df = df_h[test_mask].sort_values([symbol_col, "session_date"]).reset_index(drop=True)
        purged_df = df_h[purged_mask].sort_values([symbol_col, "session_date"]).reset_index(drop=True)

        purged_train_df = df_h[df_h["session_date"].isin(set(purged_train_dates))]
        purged_val_df = df_h[df_h["session_date"].isin(set(purged_val_dates))]

        # Accounting details
        def _get_class_counts(d: pd.DataFrame) -> Dict[str, int]:
            if len(d) == 0:
                return {}
            c_col = "target_class" if "target_class" in d.columns else "target_label"
            return {str(k): int(v) for k, v in d[c_col].value_counts().to_dict().items()}

        accounting = HorizonPurgeAccounting(
            horizon=horizon,
            pre_purge_targets_count=len(df_h),
            train_boundary_purged_count=len(purged_train_df),
            val_boundary_purged_count=len(purged_val_df),
            total_boundary_purged_count=len(purged_df),
            retained_train_count=len(train_df),
            retained_val_count=len(val_df),
            retained_test_count=len(test_df),
            total_retained_count=len(train_df) + len(val_df) + len(test_df),
            end_of_dataset_exclusions_count=0,  # Updated by caller when exclusions are provided
            train_class_counts=_get_class_counts(train_df),
            val_class_counts=_get_class_counts(val_df),
            test_class_counts=_get_class_counts(test_df),
            purged_train_dates=purged_train_dates,
            purged_val_dates=purged_val_dates,
        )

        return train_df, val_df, test_df, purged_df, accounting

    def split_features_and_targets(
        self,
        features_df: pd.DataFrame,
        targets_df: pd.DataFrame,
        clean_dates: List[str],
        horizon: int,
        feature_names: Optional[List[str]] = None,
        target_col: str = "target_label",
    ) -> Tuple[pd.DataFrame, pd.Series, pd.DataFrame, pd.Series, pd.DataFrame, pd.Series, HorizonPurgeAccounting]:
        """
        Executes an inner join of features X and targets y on (stock_symbol, session_date),
        enforces one-to-one join integrity, strictly strips any future/target-derived columns from X,
        and returns (X_train, y_train, X_val, y_val, X_test, y_test, accounting).
        """
        # 1. Enforce mandatory feature allowlist validation (fail closed; zero arbitrary fallback)
        if feature_names is None:
            raise ValueError(
                "feature_names is mandatory and cannot be None. "
                "Pass an explicit list of approved engineered feature names matching the approved 23-feature allowlist."
            )
        if not isinstance(feature_names, (list, tuple, set)) or len(feature_names) == 0:
            raise ValueError(
                "feature_names must be a non-empty sequence of approved engineered feature strings."
            )

        cleaned_feature_names: List[str] = []
        for feat in feature_names:
            if not isinstance(feat, str) or not feat.strip():
                raise ValueError(
                    f"Invalid feature name '{feat}': feature names must be non-empty strings."
                )
            cleaned_feature_names.append(feat.strip())

        # 2. Reject duplicate feature names
        seen = set()
        duplicates = []
        for feat in cleaned_feature_names:
            if feat in seen and feat not in duplicates:
                duplicates.append(feat)
            seen.add(feat)
        if duplicates:
            raise ValueError(
                f"Duplicate feature names detected in feature_names: {duplicates}. "
                "Each approved feature name must appear exactly once."
            )

        # 3. Reject unapproved feature columns
        unapproved = [c for c in cleaned_feature_names if c not in APPROVED_FEATURE_ALLOWLIST]
        if unapproved:
            raise ValueError(
                f"Unapproved feature column(s) rejected: {unapproved}. "
                f"Only features from the approved engineered feature allowlist are permitted."
            )

        # 4. Reject partial feature lists (must contain exactly the 23 unique approved engineered features)
        missing_approved = [c for c in APPROVED_FEATURE_ALLOWLIST if c not in seen]
        if missing_approved or len(cleaned_feature_names) != len(APPROVED_FEATURE_ALLOWLIST):
            raise ValueError(
                f"Partial feature list rejected: received {len(cleaned_feature_names)} features, "
                f"but exactly {len(APPROVED_FEATURE_ALLOWLIST)} approved engineered features are required. "
                f"Missing approved engineered features: {missing_approved}"
            )

        feat_df = features_df.copy()
        targ_df = targets_df[targets_df["prediction_horizon"] == horizon].copy()

        # Standardize keys
        symbol_col = "stock_symbol" if "stock_symbol" in feat_df.columns else "symbol"
        if symbol_col not in feat_df.columns:
            feat_df[symbol_col] = "UNKNOWN"
        if symbol_col not in targ_df.columns:
            targ_df[symbol_col] = "UNKNOWN"

        feat_date_col = "session_date" if "session_date" in feat_df.columns else "timestamp"
        feat_df["session_date"] = feat_df[feat_date_col].apply(lambda x: normalize_candle_timestamp(x)[1])

        targ_date_col = "session_date" if "session_date" in targ_df.columns else "signal_date"
        targ_df["session_date"] = targ_df[targ_date_col].apply(lambda x: normalize_candle_timestamp(x)[1])

        # Explicit defense-in-depth: reject any future/target-derived, nominal price, or metadata column
        forbidden_cols = FUTURE_OR_TARGET_DERIVED_COLUMNS | {
            "timestamp",
            "session_date",
            symbol_col,
            "stock_symbol",
            "symbol",
            "stock_id",
            "exchange_id",
            "close",
            "open",
            "high",
            "low",
            "volume",
        }
        forbidden_detected = [c for c in cleaned_feature_names if c in forbidden_cols]
        if forbidden_detected:
            raise ValueError(
                f"Forbidden target-derived or metadata column(s) detected in feature_names: {forbidden_detected}."
            )

        # 5. Verify all 23 approved feature columns exist in the input DataFrame
        missing_in_df = [c for c in cleaned_feature_names if c not in feat_df.columns]
        if missing_in_df:
            raise ValueError(
                f"Requested approved engineered feature column(s) missing from features DataFrame: {missing_in_df}"
            )

        active_features = list(cleaned_feature_names)

        # Enforce uniqueness of feature keys
        dupe_feats = feat_df.duplicated(subset=[symbol_col, "session_date"])
        if dupe_feats.any():
            sample_dupe_feats = feat_df[dupe_feats][[symbol_col, "session_date"]].head(3).to_dict(orient="records")
            raise ValueError(f"Duplicate feature keys detected on [{symbol_col}, 'session_date']: {sample_dupe_feats}")

        # Enforce uniqueness of target keys
        dupe_targs = targ_df.duplicated(subset=[symbol_col, "session_date"])
        if dupe_targs.any():
            sample_dupe_targs = targ_df[dupe_targs][[symbol_col, "session_date"]].head(3).to_dict(orient="records")
            raise ValueError(f"Duplicate target keys detected on [{symbol_col}, 'session_date']: {sample_dupe_targs}")

        # Partition targets first to obtain exact purged subsets
        train_targ, val_targ, test_targ, purged_targ, accounting = self.split_target_dataset(
            targ_df, clean_dates, horizon=horizon
        )

        # Join features with each partition strictly 1-to-1 on (stock_symbol, session_date)
        def _join_partition(p_targ: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
            if len(p_targ) == 0:
                return pd.DataFrame(columns=active_features), pd.Series(dtype=int)

            merged = pd.merge(
                p_targ[[symbol_col, "session_date", target_col]],
                feat_df[[symbol_col, "session_date"] + active_features],
                on=[symbol_col, "session_date"],
                how="inner",
            )
            if len(merged) != len(p_targ):
                missing_count = len(p_targ) - len(merged)
                raise ValueError(
                    f"Feature-target join integrity failed: {missing_count} target rows lacked matching features."
                )

            X_part = merged[active_features].copy()
            y_part = merged[target_col].copy()
            return X_part, y_part

        X_train, y_train = _join_partition(train_targ)
        X_val, y_val = _join_partition(val_targ)
        X_test, y_test = _join_partition(test_targ)

        return X_train, y_train, X_val, y_val, X_test, y_test, accounting

    def evaluate_multi_horizon_splits(
        self,
        features_df: pd.DataFrame,
        targets_df: pd.DataFrame,
        clean_dates: List[str],
        horizons: Optional[List[int]] = None,
        feature_names: Optional[List[str]] = None,
    ) -> PurgedSplitResult:
        """
        Constructs and audits purged split bundles across all requested prediction horizons.
        Defaults to the full approved 23-feature allowlist when feature_names is omitted.
        """
        eval_horizons = horizons or self.config.horizons
        selected_features = list(feature_names) if feature_names is not None else list(APPROVED_FEATURE_ALLOWLIST)
        boundaries = self.get_partition_boundaries(clean_dates)
        bundles: Dict[int, SplitDataBundle] = {}
        accounting_dict: Dict[int, HorizonPurgeAccounting] = {}

        for h in eval_horizons:
            X_tr, y_tr, X_va, y_va, X_te, y_te, acct = self.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=h,
                feature_names=selected_features,
            )
            accounting_dict[h] = acct
            bundles[h] = SplitDataBundle(
                horizon=h,
                feature_names=list(X_tr.columns),
                target_name="target_label",
                retained_train_indices=list(X_tr.index),
                retained_val_indices=list(X_va.index),
                retained_test_indices=list(X_te.index),
                accounting=acct,
                metadata={
                    "train_shape": list(X_tr.shape),
                    "val_shape": list(X_va.shape),
                    "test_shape": list(X_te.shape),
                },
            )

        return PurgedSplitResult(
            boundaries=boundaries,
            bundles=bundles,
            accounting=accounting_dict,
            total_clean_dates=len(clean_dates),
            metadata={
                "horizons": eval_horizons,
                "train_ratio": self.config.train_ratio,
                "val_ratio": self.config.val_ratio,
                "test_ratio": self.config.test_ratio,
                "embargo_dates": self.config.embargo_dates,
            },
        )


def fit_transform_scaler(
    X_train: pd.DataFrame,
    X_val: pd.DataFrame,
    X_test: pd.DataFrame,
    scaler: Optional[Any] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, Any]:
    """
    Enforces the strict Scaler Quarantine Protocol:
    1. Fits scaler strictly on retained X_train.
    2. Transforms X_val and X_test using the frozen parameters.
    3. Never refits or updates scaler parameters with validation or test observations.
    """
    fitted_scaler = scaler if scaler is not None else StandardScaler()
    fitted_scaler.fit(X_train)

    X_train_scaled = fitted_scaler.transform(X_train)
    X_val_scaled = fitted_scaler.transform(X_val)
    X_test_scaled = fitted_scaler.transform(X_test)

    return X_train_scaled, X_val_scaled, X_test_scaled, fitted_scaler


def get_purged_splits(
    df: pd.DataFrame,
    clean_dates: Optional[List[str]] = None,
    horizon: int = 1,
    config: Optional[SplitConfig] = None,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Convenience functional interface matching Section 10 of docs/phase-5c1-validation-methodology-review.md.

    Args:
        df: DataFrame containing target records (and optionally joined features)
        clean_dates: Aligned calendar dates (extracted from df if not provided)
        horizon: Horizon h in trading days
        config: Optional split configuration

    Returns:
        (train_sub, val_sub, test_sub) DataFrames with zero forward target overlap.
    """
    splitter = PurgedChronologicalSplitter(config or SplitConfig())
    if clean_dates is None:
        date_col = "session_date" if "session_date" in df.columns else "signal_date"
        if date_col not in df.columns:
            date_col = "timestamp"
        clean_dates = sorted(df[date_col].apply(lambda x: normalize_candle_timestamp(x)[1]).unique().tolist())

    train_df, val_df, test_df, _, _ = splitter.split_target_dataset(df, clean_dates, horizon=horizon)
    return train_df, val_df, test_df
