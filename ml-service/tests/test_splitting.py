"""
StockSense AI — Purged Grouped Chronological Splitting Test Suite
Validates mathematical boundary guarantees, cross-sectional group integrity,
zero target label leakage across partition boundaries, scaler quarantine,
feature-target join integrity, and exact historical dataset accounting.
"""

import os
import json
import pytest
import numpy as np
import pandas as pd

from app.schemas.splitting import (
    SplitPartition,
    SplitConfig,
    PartitionBoundary,
    HorizonPurgeAccounting,
)
from app.services.splitting import (
    StandardScaler,
    PurgedChronologicalSplitter,
    fit_transform_scaler,
    get_purged_splits,
    FUTURE_OR_TARGET_DERIVED_COLUMNS,
    APPROVED_FEATURE_ALLOWLIST,
)
from app.services.targets import TargetService, normalize_candle_timestamp
from app.services.features import FeatureEngineeringPipeline


# =============================================================================
# Helper Fixtures & Builders
# =============================================================================

@pytest.fixture(scope="module")
def historical_dataset():
    """Loads the authentic 5-stock 3-year historical dataset fixture."""
    path = "/Users/vansh/.gemini/antigravity/brain/0dd47e33-8dcd-41dc-b48c-008944fca820/scratch/five_stocks_candles.json"
    if not os.path.exists(path):
        pytest.skip("Historical scratch fixture five_stocks_candles.json not available")

    with open(path) as f:
        data = json.load(f)

    # Clean calendar: 544 clean dates from raw candle index 199 onward
    clean_calendar = [
        normalize_candle_timestamp(c["timestamp"])[1]
        for c in data["RELIANCE"]["candles"][199:]
    ]

    target_service = TargetService()
    feat_pipe = FeatureEngineeringPipeline()

    all_targets = []
    all_features = []

    for symbol, stock_info in data.items():
        raw_candles = stock_info["candles"]

        # Targets on 544 clean dates
        t_res = target_service.generate(
            raw_candles[199:],
            symbol=symbol,
            horizons=[1, 3, 5],
            expected_sessions=clean_calendar,
        )
        t_df = t_res.to_dataframe()
        all_targets.append(t_df)

        # Features with drop_na=True (544 clean feature rows)
        f_res = feat_pipe.extract_features(raw_candles, drop_na=True)
        f_df = pd.DataFrame(f_res["features"])
        f_df["session_date"] = f_df["timestamp"].apply(lambda ts: normalize_candle_timestamp(ts)[1])
        f_df["stock_symbol"] = symbol
        all_features.append(f_df)

    targets_df = pd.concat(all_targets, ignore_index=True)
    features_df = pd.concat(all_features, ignore_index=True)

    return {
        "calendar": clean_calendar,
        "targets_df": targets_df,
        "features_df": features_df,
    }


# =============================================================================
# 1. Scaler Correctness & Quarantine Tests
# =============================================================================

class TestScalerCorrectnessAndQuarantine:
    def test_population_standard_deviation_ddof_zero(self):
        """
        Verify that StandardScaler uses population standard deviation (ddof=0).
        """
        X_train = pd.DataFrame({
            "feat1": [1.0, 2.0, 3.0, 4.0, 5.0],
            "feat2": [10.0, 20.0, 30.0, 40.0, 50.0],
        })
        scaler = StandardScaler()
        scaler.fit(X_train)

        # Expected population variance (ddof=0)
        expected_var = np.var(X_train.to_numpy(), axis=0, ddof=0)
        expected_scale = np.sqrt(expected_var)

        np.testing.assert_allclose(scaler.mean_, X_train.mean(axis=0).to_numpy())
        np.testing.assert_allclose(scaler.var_, expected_var)
        np.testing.assert_allclose(scaler.scale_, expected_scale)

    def test_constant_feature_handling(self):
        """
        Verify that constant / zero-variance features are handled safely with scale_ = 1.0.
        """
        X = pd.DataFrame({
            "constant_col": [5.0, 5.0, 5.0, 5.0],
            "varying_col": [1.0, 2.0, 3.0, 4.0],
        })
        scaler = StandardScaler()
        scaler.fit(X)

        assert scaler.scale_[0] == 1.0  # Constant column scaled by 1.0
        assert scaler.var_[0] == 0.0

        scaled = scaler.transform(X)
        assert not scaled.isna().any().any()
        assert np.all(scaled["constant_col"] == 0.0)  # (5 - 5) / 1.0 = 0.0

    def test_fit_exclusively_on_retained_train_never_updates_on_val_or_test(self):
        """
        Verify that StandardScaler parameters are frozen after training fit,
        and transforming validation or test sets does not update scaler parameters.
        """
        X_train = pd.DataFrame({"feat": [10.0, 20.0, 30.0]})
        X_val = pd.DataFrame({"feat": [100.0, 200.0, 300.0]})
        X_test = pd.DataFrame({"feat": [1000.0, 2000.0, 3000.0]})

        X_tr_s, X_va_s, X_te_s, scaler = fit_transform_scaler(X_train, X_val, X_test)

        # Check mean and scale match train exactly
        assert scaler.mean_[0] == pytest.approx(20.0)
        initial_mean = scaler.mean_.copy()
        initial_scale = scaler.scale_.copy()

        # Transform again to ensure parameters remain completely frozen
        _ = scaler.transform(X_test)
        np.testing.assert_array_equal(scaler.mean_, initial_mean)
        np.testing.assert_array_equal(scaler.scale_, initial_scale)

        # Check scaling formula: (100 - 20) / sqrt(var_train)
        expected_val_0 = (100.0 - scaler.mean_[0]) / scaler.scale_[0]
        assert X_va_s.iloc[0, 0] == pytest.approx(expected_val_0)


# =============================================================================
# 2. Feature-Target Join Integrity & Leakage Protection
# =============================================================================

class TestFeatureTargetJoinIntegrity:
    def test_one_to_one_join_enforced(self, historical_dataset):
        """
        Verify that features and targets join strictly 1-to-1 on (stock_symbol, session_date).
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        for h in [1, 3, 5]:
            X_tr, y_tr, X_va, y_va, X_te, y_te, acct = splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=h,
                feature_names=list(APPROVED_FEATURE_ALLOWLIST),
            )
            # Feature row count must match target row count bit-for-bit
            assert len(X_tr) == len(y_tr) == acct.retained_train_count
            assert len(X_va) == len(y_va) == acct.retained_val_count
            assert len(X_te) == len(y_te) == acct.retained_test_count

    def test_reject_duplicate_feature_keys(self):
        """
        Verify that duplicate (stock_symbol, session_date) in features raises ValueError.
        """
        row1 = {"stock_symbol": "RELIANCE", "session_date": "2025-01-01"}
        row2 = {"stock_symbol": "RELIANCE", "session_date": "2025-01-01"}  # Duplicate key
        for feat in APPROVED_FEATURE_ALLOWLIST:
            row1[feat] = 1.0
            row2[feat] = 2.0
        features_df = pd.DataFrame([row1, row2])
        targets_df = pd.DataFrame([
            {"stock_symbol": "RELIANCE", "session_date": "2025-01-01", "prediction_horizon": 1, "target_label": 1},
        ])
        splitter = PurgedChronologicalSplitter()
        with pytest.raises(ValueError, match="Duplicate feature keys detected"):
            splitter.split_features_and_targets(
                features_df, targets_df, clean_dates=["2025-01-01"], horizon=1, feature_names=list(APPROVED_FEATURE_ALLOWLIST)
            )

    def test_reject_duplicate_target_keys(self):
        """
        Verify that duplicate (stock_symbol, session_date) in targets raises ValueError.
        """
        row = {"stock_symbol": "RELIANCE", "session_date": "2025-01-01"}
        for feat in APPROVED_FEATURE_ALLOWLIST:
            row[feat] = 1.0
        features_df = pd.DataFrame([row])
        targets_df = pd.DataFrame([
            {"stock_symbol": "RELIANCE", "session_date": "2025-01-01", "prediction_horizon": 1, "target_label": 1},
            {"stock_symbol": "RELIANCE", "session_date": "2025-01-01", "prediction_horizon": 1, "target_label": -1},  # Duplicate
        ])
        splitter = PurgedChronologicalSplitter()
        with pytest.raises(ValueError, match="Duplicate target keys detected"):
            splitter.split_features_and_targets(
                features_df, targets_df, clean_dates=["2025-01-01"], horizon=1, feature_names=list(APPROVED_FEATURE_ALLOWLIST)
            )

    def test_explicit_exclusion_of_target_derived_columns_from_feature_matrix(self, historical_dataset):
        """
        Verify that future-derived columns (entry/exit prices, forward returns, labels)
        are explicitly excluded from the feature matrix X.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        X_tr, _, _, _, _, _, _ = splitter.split_features_and_targets(
            features_df=features_df,
            targets_df=targets_df,
            clean_dates=clean_dates,
            horizon=1,
            feature_names=list(APPROVED_FEATURE_ALLOWLIST),
        )

        for col in FUTURE_OR_TARGET_DERIVED_COLUMNS:
            assert col not in X_tr.columns, f"Target-derived column '{col}' leaked into feature matrix X!"

    def test_cross_sectional_group_integrity_across_all_five_stocks(self, historical_dataset):
        """
        Verify that all stocks for any given date belong to the identical partition.
        No date can belong to Train for one stock and Val/Test for another.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        targets_df = historical_dataset["targets_df"]

        train_df, val_df, test_df, purged_df, _ = splitter.split_target_dataset(
            targets_df, clean_dates, horizon=1
        )

        train_df["partition"] = "train"
        val_df["partition"] = "val"
        test_df["partition"] = "test"
        purged_df["partition"] = "purged"

        combined = pd.concat([train_df, val_df, test_df, purged_df], ignore_index=True)

        for date, group in combined.groupby("session_date"):
            partitions = group["partition"].unique()
            assert len(partitions) == 1, (
                f"Cross-sectional leakage: Date {date} split across multiple partitions: {partitions}"
            )


# =============================================================================
# 3. Purge Accounting & Zero Boundary Target Leakage Tests
# =============================================================================

class TestPurgeAccountingAndBoundaryLeakage:
    def test_zero_target_boundary_leakage_across_all_horizons(self, historical_dataset):
        """
        Verify that no training target references validation prices, and no val target references test prices:
        max(train_exit_date) < min(val_entry_date)
        max(val_exit_date) < min(test_entry_date)
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        targets_df = historical_dataset["targets_df"]

        for h in [1, 3, 5]:
            train_df, val_df, test_df, _, acct = splitter.split_target_dataset(
                targets_df, clean_dates, horizon=h
            )

            # Max exit date in retained Train
            max_train_exit_date = train_df["exit_date"].max()
            # Min entry date in retained Validation
            min_val_entry_date = val_df["entry_date"].min()

            assert max_train_exit_date < min_val_entry_date, (
                f"Target leakage at h={h}: Train max exit date {max_train_exit_date} "
                f">= Val min entry date {min_val_entry_date}"
            )

            # Max exit date in retained Validation
            max_val_exit_date = val_df["exit_date"].max()
            # Min entry date in retained Test
            min_test_entry_date = test_df["entry_date"].min()

            assert max_val_exit_date < min_test_entry_date, (
                f"Target leakage at h={h}: Val max exit date {max_val_exit_date} "
                f">= Test min entry date {min_test_entry_date}"
            )

    def test_train_and_val_boundary_purges_reported_separately(self, historical_dataset):
        """
        Verify that train boundary purges and validation boundary purges are reported separately
        and equal exact theoretical counts (h dates * 5 stocks per boundary).
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        targets_df = historical_dataset["targets_df"]

        for h in [1, 3, 5]:
            _, _, _, _, acct = splitter.split_target_dataset(targets_df, clean_dates, horizon=h)

            expected_purged_per_boundary = h * 5
            assert acct.train_boundary_purged_count == expected_purged_per_boundary
            assert acct.val_boundary_purged_count == expected_purged_per_boundary
            assert acct.total_boundary_purged_count == expected_purged_per_boundary * 2

    def test_temporal_monotonicity_of_partitions(self, historical_dataset):
        """
        Verify strict temporal monotonicity:
        max(Train dates) < min(Val dates) < max(Val dates) < min(Test dates)
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        date_splits = splitter.split_calendar_dates(clean_dates)

        train_dates = date_splits[SplitPartition.TRAIN]
        val_dates = date_splits[SplitPartition.VAL]
        test_dates = date_splits[SplitPartition.TEST]

        assert max(train_dates) < min(val_dates)
        assert max(val_dates) < min(test_dates)

    def test_embargo_dates_parameter(self, historical_dataset):
        """
        Verify that setting embargo_dates > 0 introduces an additional blackout buffer
        at the beginning of subsequent partitions.
        """
        clean_dates = historical_dataset["calendar"]
        targets_df = historical_dataset["targets_df"]

        # Baseline E = 0
        splitter_e0 = PurgedChronologicalSplitter(SplitConfig(embargo_dates=0))
        _, val_e0, test_e0, _, _ = splitter_e0.split_target_dataset(targets_df, clean_dates, horizon=1)

        # Embargo E = 5
        splitter_e5 = PurgedChronologicalSplitter(SplitConfig(embargo_dates=5))
        _, val_e5, test_e5, _, _ = splitter_e5.split_target_dataset(targets_df, clean_dates, horizon=1)

        # Validation retained count decreases by 5 dates * 5 stocks = 25 observations
        assert len(val_e5) == len(val_e0) - 25
        # Test retained count decreases by 5 dates * 5 stocks = 25 observations
        assert len(test_e5) == len(test_e0) - 25


# =============================================================================
# 4. Horizon Isolation & Target Consistency
# =============================================================================

class TestHorizonIsolation:
    def test_horizon_isolation_bundles(self, historical_dataset):
        """
        Verify that split bundles for h1, h3, and h5 are completely isolated
        and never mix target labels or returns from different horizons.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        result = splitter.evaluate_multi_horizon_splits(features_df, targets_df, clean_dates)

        assert set(result.bundles.keys()) == {1, 3, 5}

        for h, bundle in result.bundles.items():
            assert bundle.horizon == h
            # Verify feature matrix dimensions match 23 features
            assert len(bundle.feature_names) == 23


# =============================================================================
# 5. Historical Dataset Regression & Exact Count Reproduction
# =============================================================================

class TestHistoricalDatasetSplittingRegression:
    def test_exact_observation_counts_and_boundaries_reproduced(self, historical_dataset):
        """
        Verifies exact numerical reproduction of nominal boundaries, retained observation counts,
        boundary purge counts, and class distributions across all three horizons.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        targets_df = historical_dataset["targets_df"]
        features_df = historical_dataset["features_df"]

        assert len(clean_dates) == 544

        # Nominal boundaries check
        boundaries = splitter.get_partition_boundaries(clean_dates)
        assert boundaries["train"].nominal_dates_count == 380
        assert boundaries["train"].start_date == "2024-09-02"
        assert boundaries["train"].end_date == "2026-03-11"

        assert boundaries["val"].nominal_dates_count == 81
        assert boundaries["val"].start_date == "2026-03-12"
        assert boundaries["val"].end_date == "2026-07-13"

        assert boundaries["test"].nominal_dates_count == 83
        assert boundaries["test"].start_date == "2026-07-14"
        assert boundaries["test"].end_date == "2026-11-09"

        # Horizon h=1
        tr1, va1, te1, pu1, ac1 = splitter.split_target_dataset(targets_df, clean_dates, horizon=1)
        assert len(tr1) == 1895
        assert len(va1) == 400
        assert len(te1) == 410
        assert len(pu1) == 10
        assert ac1.train_boundary_purged_count == 5
        assert ac1.val_boundary_purged_count == 5
        assert ac1.train_class_counts == {"NEUTRAL": 756, "DOWN": 602, "UP": 537}
        assert ac1.val_class_counts == {"DOWN": 145, "UP": 134, "NEUTRAL": 121}
        assert ac1.test_class_counts == {"DOWN": 144, "NEUTRAL": 143, "UP": 123}

        # Horizon h=3
        tr3, va3, te3, pu3, ac3 = splitter.split_target_dataset(targets_df, clean_dates, horizon=3)
        assert len(tr3) == 1885
        assert len(va3) == 390
        assert len(te3) == 400
        assert len(pu3) == 30
        assert ac3.train_boundary_purged_count == 15
        assert ac3.val_boundary_purged_count == 15
        assert ac3.train_class_counts == {"NEUTRAL": 784, "DOWN": 592, "UP": 509}
        assert ac3.val_class_counts == {"DOWN": 148, "UP": 127, "NEUTRAL": 115}
        assert ac3.test_class_counts == {"NEUTRAL": 139, "DOWN": 138, "UP": 123}

        # Horizon h=5
        tr5, va5, te5, pu5, ac5 = splitter.split_target_dataset(targets_df, clean_dates, horizon=5)
        assert len(tr5) == 1875
        assert len(va5) == 380
        assert len(te5) == 390
        assert len(pu5) == 50
        assert ac5.train_boundary_purged_count == 25
        assert ac5.val_boundary_purged_count == 25
        assert ac5.train_class_counts == {"NEUTRAL": 864, "DOWN": 550, "UP": 461}
        assert ac5.val_class_counts == {"DOWN": 145, "NEUTRAL": 124, "UP": 111}
        assert ac5.test_class_counts == {"NEUTRAL": 153, "DOWN": 128, "UP": 109}

        # Total retained across all 3 horizons = 2705 + 2675 + 2645 = 8025
        total_retained = len(tr1) + len(va1) + len(te1) + len(tr3) + len(va3) + len(te3) + len(tr5) + len(va5) + len(te5)
        assert total_retained == 8025
        # Total boundary purges = 10 + 30 + 50 = 90
        total_purged = len(pu1) + len(pu3) + len(pu5)
        assert total_purged == 90
        # Pre-purge targets total = 8025 + 90 = 8115
        assert total_retained + total_purged == 8115

    def test_functional_get_purged_splits_interface(self, historical_dataset):
        """
        Verify convenience functional interface get_purged_splits(df, horizon).
        """
        targets_df = historical_dataset["targets_df"]
        clean_dates = historical_dataset["calendar"]

        tr1, va1, te1 = get_purged_splits(targets_df, clean_dates=clean_dates, horizon=1)
        assert len(tr1) == 1895
        assert len(va1) == 400
        assert len(te1) == 410


# =============================================================================
# 6. Feature Allowlist Hardening & Rejection Tests
# =============================================================================

class TestFeatureAllowlistHardening:
    def test_approved_feature_allowlist_composition(self):
        """
        Verify that APPROVED_FEATURE_ALLOWLIST contains exactly 23 scale-invariant features
        and contains zero future-derived, nominal price, or metadata columns.
        """
        assert len(APPROVED_FEATURE_ALLOWLIST) == 23
        assert len(set(APPROVED_FEATURE_ALLOWLIST)) == 23

        # Zero overlap with future or target-derived columns
        overlap = set(APPROVED_FEATURE_ALLOWLIST).intersection(FUTURE_OR_TARGET_DERIVED_COLUMNS)
        assert len(overlap) == 0, f"Target-derived columns found in allowlist: {overlap}"

        # Zero overlap with nominal price or metadata columns
        forbidden = {"timestamp", "session_date", "close", "open", "high", "low", "volume", "stock_symbol"}
        nominal_overlap = set(APPROVED_FEATURE_ALLOWLIST).intersection(forbidden)
        assert len(nominal_overlap) == 0, f"Nominal/metadata columns found in allowlist: {nominal_overlap}"

    def test_split_features_and_targets_rejects_none_feature_names(self, historical_dataset):
        """
        Verify that omitting feature_names (or passing None) explicitly fails closed.
        Never falls back to selecting arbitrary DataFrame columns.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="feature_names is mandatory and cannot be None"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=None,
            )

    def test_split_features_and_targets_rejects_empty_feature_names(self, historical_dataset):
        """
        Verify that passing an empty list or invalid sequence raises ValueError.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="feature_names must be a non-empty sequence"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=[],
            )

    def test_split_features_and_targets_rejects_invalid_type_feature_names(self, historical_dataset):
        """
        Verify that passing non-string items or blank strings raises ValueError.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="Invalid feature name"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=["price_to_sma20", ""],
            )

    def test_split_features_and_targets_rejects_unapproved_future_leak_columns(self, historical_dataset):
        """
        Verify that unfamiliar columns (e.g. synthetic_future_leak) are rejected immediately.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"].copy()
        features_df["synthetic_future_leak"] = 999.0
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="Unapproved feature column\\(s\\) rejected.*synthetic_future_leak"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=["price_to_sma20", "synthetic_future_leak"],
            )

    def test_split_features_and_targets_rejects_target_derived_columns_in_request(self, historical_dataset):
        """
        Verify that requesting target labels or returns as features is rejected.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="Unapproved feature column\\(s\\) rejected"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=["price_to_sma20", "target_label"],
            )

    def test_split_features_and_targets_rejects_nominal_price_columns_in_request(self, historical_dataset):
        """
        Verify that requesting nominal 'close' price is rejected.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="Unapproved feature column\\(s\\) rejected"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=["price_to_sma20", "close"],
            )

    def test_split_features_and_targets_rejects_duplicate_feature_names(self, historical_dataset):
        """
        Verify that passing duplicate feature names raises ValueError.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        dupe_names = ["price_to_sma20"] + list(APPROVED_FEATURE_ALLOWLIST)
        with pytest.raises(ValueError, match="Duplicate feature names detected in feature_names.*price_to_sma20"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=dupe_names,
            )

    def test_split_features_and_targets_rejects_partial_feature_lists(self, historical_dataset):
        """
        Verify that partial feature lists (fewer than 23 features) are strictly rejected.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        # Partial list of 22 features (missing last feature)
        partial_names = list(APPROVED_FEATURE_ALLOWLIST)[:-1]
        with pytest.raises(ValueError, match="Partial feature list rejected.*received 22 features, but exactly 23 approved engineered features are required"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=partial_names,
            )

        # Partial list of 1 feature
        with pytest.raises(ValueError, match="Partial feature list rejected.*received 1 features, but exactly 23 approved engineered features are required"):
            splitter.split_features_and_targets(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                horizon=1,
                feature_names=["price_to_sma20"],
            )

    def test_split_features_and_targets_rejects_missing_column_in_dataframe(self):
        """
        Verify that if an approved feature is requested but absent from features_df, it raises ValueError.
        """
        data = {"stock_symbol": ["RELIANCE"], "session_date": ["2025-01-01"]}
        for col in APPROVED_FEATURE_ALLOWLIST:
            if col != "price_to_sma50":
                data[col] = [1.0]
        features_df = pd.DataFrame(data)
        targets_df = pd.DataFrame([
            {"stock_symbol": "RELIANCE", "session_date": "2025-01-01", "prediction_horizon": 1, "target_label": 1},
        ])
        splitter = PurgedChronologicalSplitter()
        with pytest.raises(ValueError, match="missing from features DataFrame.*price_to_sma50"):
            splitter.split_features_and_targets(
                features_df,
                targets_df,
                clean_dates=["2025-01-01"],
                horizon=1,
                feature_names=list(APPROVED_FEATURE_ALLOWLIST),
            )

    def test_evaluate_multi_horizon_splits_defaults_to_all_23_approved_features(self, historical_dataset):
        """
        Verify that evaluate_multi_horizon_splits defaults to all 23 approved features
        and safely passes the allowlist validation.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        res = splitter.evaluate_multi_horizon_splits(features_df, targets_df, clean_dates)
        for h, bundle in res.bundles.items():
            assert bundle.feature_names == list(APPROVED_FEATURE_ALLOWLIST)
            assert len(bundle.feature_names) == 23

    def test_evaluate_multi_horizon_splits_rejects_unapproved_features(self, historical_dataset):
        """
        Verify that evaluate_multi_horizon_splits fails closed when unapproved features are passed.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        with pytest.raises(ValueError, match="Unapproved feature column\\(s\\) rejected"):
            splitter.evaluate_multi_horizon_splits(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                feature_names=["price_to_sma20", "future_leak"],
            )

    def test_evaluate_multi_horizon_splits_rejects_duplicate_features(self, historical_dataset):
        """
        Verify that evaluate_multi_horizon_splits fails closed when duplicate features are passed.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        dupes = ["price_to_sma20"] + list(APPROVED_FEATURE_ALLOWLIST)
        with pytest.raises(ValueError, match="Duplicate feature names detected"):
            splitter.evaluate_multi_horizon_splits(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                feature_names=dupes,
            )

    def test_evaluate_multi_horizon_splits_rejects_partial_features(self, historical_dataset):
        """
        Verify that evaluate_multi_horizon_splits fails closed when a partial feature list is passed.
        """
        splitter = PurgedChronologicalSplitter()
        clean_dates = historical_dataset["calendar"]
        features_df = historical_dataset["features_df"]
        targets_df = historical_dataset["targets_df"]

        partial = list(APPROVED_FEATURE_ALLOWLIST)[:-1]
        with pytest.raises(ValueError, match="Partial feature list rejected"):
            splitter.evaluate_multi_horizon_splits(
                features_df=features_df,
                targets_df=targets_df,
                clean_dates=clean_dates,
                feature_names=partial,
            )
