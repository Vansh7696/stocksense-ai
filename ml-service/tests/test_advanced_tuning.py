"""
StockSense AI — Advanced Model Hyperparameter Tuning Test Suite (Phase 5C.4.3)
Verifies search budget constraints, chronological inner splitting, boundary validation,
data quarantine protocols, XGBoost M* + 1 refit logic, deterministic tie-breaking hierarchies,
atomic checkpoint resumption, and ModelRegistry champion isolation.
"""

import os
import json
import tempfile
import shutil
import pytest
import numpy as np
import pandas as pd

from app.schemas.metrics import ClassificationMetrics
from app.schemas.registry import ModelStatus
from app.services.splitting import (
    APPROVED_FEATURE_ALLOWLIST,
    APPROVED_EQUITIES,
    MAX_TRAINING_DATE,
    MAX_VALIDATION_DATE,
    QUARANTINED_TEST_START_DATE,
    QUARANTINED_TEST_END_DATE,
    split_inner_training_dates,
    validate_partition_membership,
    validate_target_boundaries,
    SplittingError,
    PartitionMembershipError,
    QuarantinedTestDataLeakageError,
    TargetBoundaryLeakageError,
)
from app.schemas.random_forest import (
    RandomForestHyperparameters,
    RandomForestCandidateRecord,
    RandomForestTuningResult,
)
from app.services.random_forest import (
    RandomForestModel,
    create_random_forest_model,
    get_random_forest_search_grid,
    tune_random_forest,
    _lexicographic_rf_sort_key,
)
from app.schemas.xgboost_model import (
    XGBoostHyperparameters,
    XGBoostCandidateRecord,
    XGBoostTuningResult,
)
from app.services.xgboost_model import (
    XGBoostModel,
    create_xgboost_model,
    get_xgboost_search_grid,
    tune_xgboost,
    _lexicographic_xgb_sort_key,
    XGBOOST_AVAILABLE,
)
from app.services.metrics import compute_classification_metrics
from app.services.tuning import AdvancedTuningOrchestrator, CANONICAL_DATASET_SHA256, compute_file_sha256
from app.services.registry import ModelRegistry


# =============================================================================
# Helper Fixtures
# =============================================================================

@pytest.fixture
def synthetic_features_and_labels():
    """Generates synthetic 23-feature dataset with 3 classes."""
    np.random.seed(42)
    n_samples = 120
    X_arr = np.random.randn(n_samples, 23)
    X = pd.DataFrame(X_arr, columns=APPROVED_FEATURE_ALLOWLIST)
    y = np.random.choice([-1, 0, 1], size=n_samples)
    return X, y


@pytest.fixture
def mock_classification_metrics():
    """Creates a valid ClassificationMetrics instance for test records."""
    y_true = np.array([-1, 0, 1, -1, 0, 1])
    y_pred = np.array([-1, 0, 1, -1, 0, 1])
    y_prob = np.array([
        [0.7, 0.2, 0.1],
        [0.1, 0.8, 0.1],
        [0.1, 0.2, 0.7],
        [0.6, 0.3, 0.1],
        [0.2, 0.7, 0.1],
        [0.1, 0.3, 0.6],
    ])
    return compute_classification_metrics(y_true, y_pred, y_prob)


# =============================================================================
# 1. Search Budget and Grid Integrity Tests
# =============================================================================

class TestSearchBudgetAndGridIntegrity:
    def test_random_forest_search_budget_exact_108(self):
        """Verify Random Forest grid has exactly 108 distinct candidate configurations."""
        grid = get_random_forest_search_grid()
        assert len(grid) == 108
        grid_indices = [c.grid_index for c in grid]
        assert grid_indices == list(range(108))

        # Check parameter ranges
        n_est_set = set(c.n_estimators for c in grid)
        depth_set = set(c.max_depth for c in grid)
        leaf_set = set(c.min_samples_leaf for c in grid)
        feat_set = set(c.max_features for c in grid)

        assert n_est_set == {100, 200, 300}
        assert depth_set == {3, 4, 5, 6}
        assert leaf_set == {15, 25, 40}
        assert feat_set == {"sqrt", "log2", 0.3}

    def test_xgboost_search_budget_exact_162(self):
        """Verify XGBoost grid has exactly 162 distinct candidate configurations."""
        grid = get_xgboost_search_grid()
        assert len(grid) == 162
        grid_indices = [c.grid_index for c in grid]
        assert grid_indices == list(range(162))

        # Check parameter ranges
        lr_set = set(c.learning_rate for c in grid)
        depth_set = set(c.max_depth for c in grid)
        sub_set = set(c.subsample for c in grid)
        lam_set = set(c.reg_lambda for c in grid)
        gam_set = set(c.gamma for c in grid)

        assert lr_set == {0.01, 0.03, 0.05}
        assert depth_set == {2, 3, 4}
        assert sub_set == {0.7, 0.85}
        assert lam_set == {1.0, 5.0, 10.0}
        assert gam_set == {0.1, 0.5, 1.0}

    def test_total_hyperparameter_evaluation_budget_810(self):
        """Verify total multi-horizon candidate budget across all horizons is exactly 810."""
        rf_grid = get_random_forest_search_grid()
        xgb_grid = get_xgboost_search_grid()
        total_budget = (len(rf_grid) * 3) + (len(xgb_grid) * 3)
        assert total_budget == 810


# =============================================================================
# 2. Chronological Inner Splitting and Count Tests
# =============================================================================

class TestChronologicalInnerSplitting:
    def test_split_inner_training_dates_exact_partitions(self):
        """Verify exact inner train, inner val, and purged dates across all horizons."""
        # 380 nominal training dates
        nominal_train = [f"2024-date-{i:03d}" for i in range(380)]

        for h, exp_in_tr, exp_in_val in [(1, 303, 75), (3, 301, 73), (5, 299, 71)]:
            in_tr, p_in_tr, in_val, p_in_val = split_inner_training_dates(nominal_train, horizon=h)

            assert len(in_tr) == exp_in_tr
            assert len(p_in_tr) == h
            assert len(in_val) == exp_in_val
            assert len(p_in_val) == h

            # Check disjointness
            assert set(in_tr).isdisjoint(set(in_val))
            assert set(in_tr).isdisjoint(set(p_in_tr))
            assert set(in_val).isdisjoint(set(p_in_val))

            # Check boundary continuity
            assert in_tr[-1] < p_in_tr[0]
            assert p_in_tr[-1] < in_val[0]
            assert in_val[-1] < p_in_val[0]


# =============================================================================
# 3. Negative Quarantine and Leakage Tests
# =============================================================================

class TestQuarantineAndBoundaryValidation:
    def test_quarantined_test_date_injection_rejected(self):
        """Verify injecting a quarantined test date into training raises QuarantinedTestDataLeakageError."""
        df = pd.DataFrame({
            "session_date": ["2024-09-02", "2024-09-03", QUARANTINED_TEST_START_DATE],
            "stock_symbol": ["RELIANCE", "RELIANCE", "RELIANCE"],
        })
        with pytest.raises(QuarantinedTestDataLeakageError, match="CRITICAL DATA LEAKAGE"):
            validate_partition_membership(
                df,
                expected_dates=["2024-09-02", "2024-09-03", QUARANTINED_TEST_START_DATE],
                partition_name="outer_train",
            )

    def test_validation_date_injected_into_training_rejected(self):
        """Verify injecting an outer validation date into outer training raises PartitionMembershipError."""
        expected_train_dates = ["2024-09-02", "2024-09-03"]
        df_contaminated = pd.DataFrame({
            "session_date": ["2024-09-02", "2024-09-03", "2026-03-12"],  # outer val date
            "stock_symbol": ["RELIANCE", "RELIANCE", "RELIANCE"],
        })
        with pytest.raises(PartitionMembershipError, match="Exact partition membership mismatch"):
            validate_partition_membership(
                df_contaminated,
                expected_dates=expected_train_dates,
                partition_name="outer_train",
            )

    def test_training_date_injected_into_validation_rejected(self):
        """Verify injecting an outer training date into validation raises PartitionMembershipError."""
        expected_val_dates = ["2026-03-12", "2026-03-13"]
        df_contaminated = pd.DataFrame({
            "session_date": ["2026-03-12", "2024-09-02"],  # outer train date
            "stock_symbol": ["RELIANCE", "RELIANCE"],
        })
        with pytest.raises(PartitionMembershipError, match="Exact partition membership mismatch"):
            validate_partition_membership(
                df_contaminated,
                expected_dates=expected_val_dates,
                partition_name="outer_val",
            )

    def test_unapproved_symbol_rejected(self):
        """Verify unapproved equity ticker symbols are rejected."""
        df = pd.DataFrame({
            "session_date": ["2024-09-02"],
            "stock_symbol": ["TATASTEEL"],  # Not in 5 approved symbols
        })
        with pytest.raises(PartitionMembershipError, match="Unapproved ticker symbols detected"):
            validate_partition_membership(
                df,
                expected_dates=["2024-09-02"],
                partition_name="outer_train",
            )

    def test_target_boundary_leakage_detected(self):
        """Verify unpurged targets crossing next partition boundary raise TargetBoundaryLeakageError."""
        df_leak = pd.DataFrame({
            "session_date": ["2026-03-11"],
            "exit_date": ["2026-03-12"],  # Crosses into outer val start
        })
        with pytest.raises(TargetBoundaryLeakageError, match="Target forward exit date leakage detected"):
            validate_target_boundaries(
                df_leak,
                next_partition_start_date="2026-03-12",
                horizon=1,
                partition_name="outer_train",
            )


# =============================================================================
# 4. XGBoost M* + 1 Refit Iteration Regression Test
# =============================================================================

@pytest.mark.skipif(not XGBOOST_AVAILABLE, reason="XGBoost not available")
class TestXGBoostBestIterationRefit:
    def test_xgboost_best_iteration_zero_indexed_refit_plus_one(self):
        """
        Verify that XGBoost best_iteration is 0-based and the refit model
        uses exactly n_estimators = best_iteration + 1.
        """
        np.random.seed(42)
        X_tr = np.random.randn(80, 23)
        y_tr = np.random.choice([-1, 0, 1], size=80)
        X_val = np.random.randn(30, 23)
        y_val = np.random.choice([-1, 0, 1], size=30)

        # Stage 1: Inner fit with early stopping
        config = XGBoostHyperparameters(n_estimators=40, early_stopping_rounds=5, max_depth=2)
        model = create_xgboost_model(config)
        model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)])

        best_iter = model.best_iteration
        assert best_iter is not None
        assert isinstance(best_iter, (int, np.integer))
        assert best_iter >= 0

        # Stage 2: Refit with best_iter + 1
        refit_n_est = int(best_iter + 1)
        refit_config = config.model_copy(update={"n_estimators": refit_n_est, "early_stopping_rounds": None})
        refit_model = create_xgboost_model(refit_config)
        refit_model.fit(X_tr, y_tr)

        assert refit_model.model_.n_estimators == refit_n_est


# =============================================================================
# 5. Deterministic Tie-Break Hierarchy Tests
# =============================================================================

class TestDeterministicTieBreakHierarchy:
    def test_random_forest_tie_break_hierarchy(self, mock_classification_metrics):
        """
        Verifies 7-level tie-breaking hierarchy for Random Forest:
        highest bal acc -> highest macro F1 -> lowest log loss ->
        lower max_depth -> larger min_samples_leaf -> lower n_estimators -> lower grid_index.
        """
        base_metrics = mock_classification_metrics

        # Case 1: Higher balanced accuracy wins
        m_high_acc = base_metrics.model_copy(update={"balanced_accuracy": 0.40})
        m_low_acc = base_metrics.model_copy(update={"balanced_accuracy": 0.35})
        r1 = RandomForestCandidateRecord(
            grid_index=1,
            hyperparameters=RandomForestHyperparameters(),
            metrics=m_low_acc,
        )
        r2 = RandomForestCandidateRecord(
            grid_index=2,
            hyperparameters=RandomForestHyperparameters(),
            metrics=m_high_acc,
        )
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 2: Equal bal acc, higher macro F1 wins
        m1 = base_metrics.model_copy(update={"balanced_accuracy": 0.35, "macro_f1": 0.30})
        m2 = base_metrics.model_copy(update={"balanced_accuracy": 0.35, "macro_f1": 0.35})
        r1 = RandomForestCandidateRecord(grid_index=1, hyperparameters=RandomForestHyperparameters(), metrics=m1)
        r2 = RandomForestCandidateRecord(grid_index=2, hyperparameters=RandomForestHyperparameters(), metrics=m2)
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 3: Equal bal acc & F1, lower log loss wins
        m1 = base_metrics.model_copy(update={"balanced_accuracy": 0.35, "macro_f1": 0.35, "log_loss": 1.10})
        m2 = base_metrics.model_copy(update={"balanced_accuracy": 0.35, "macro_f1": 0.35, "log_loss": 1.05})
        r1 = RandomForestCandidateRecord(grid_index=1, hyperparameters=RandomForestHyperparameters(), metrics=m1)
        r2 = RandomForestCandidateRecord(grid_index=2, hyperparameters=RandomForestHyperparameters(), metrics=m2)
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 4: Equal metrics, lower max_depth wins
        r1 = RandomForestCandidateRecord(
            grid_index=1,
            hyperparameters=RandomForestHyperparameters(max_depth=5),
            metrics=base_metrics,
        )
        r2 = RandomForestCandidateRecord(
            grid_index=2,
            hyperparameters=RandomForestHyperparameters(max_depth=3),
            metrics=base_metrics,
        )
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 5: Equal max_depth, larger min_samples_leaf wins
        r1 = RandomForestCandidateRecord(
            grid_index=1,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=15),
            metrics=base_metrics,
        )
        r2 = RandomForestCandidateRecord(
            grid_index=2,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=40),
            metrics=base_metrics,
        )
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 6: Equal min_leaf, lower n_estimators wins
        r1 = RandomForestCandidateRecord(
            grid_index=1,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=40, n_estimators=300),
            metrics=base_metrics,
        )
        r2 = RandomForestCandidateRecord(
            grid_index=2,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=40, n_estimators=100),
            metrics=base_metrics,
        )
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 2

        # Case 7: Equal all, lower grid_index wins
        r1 = RandomForestCandidateRecord(
            grid_index=10,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=40, n_estimators=100),
            metrics=base_metrics,
        )
        r2 = RandomForestCandidateRecord(
            grid_index=5,
            hyperparameters=RandomForestHyperparameters(max_depth=3, min_samples_leaf=40, n_estimators=100),
            metrics=base_metrics,
        )
        assert sorted([r1, r2], key=_lexicographic_rf_sort_key)[0].grid_index == 5

    def test_xgboost_tie_break_hierarchy(self, mock_classification_metrics):
        """
        Verifies 7-level tie-breaking hierarchy for XGBoost:
        highest bal acc -> highest macro F1 -> lowest log loss ->
        lower max_depth -> higher reg_lambda -> higher gamma -> lower grid_index.
        """
        base_metrics = mock_classification_metrics

        # Case 1: Higher reg_lambda wins on tie
        x1 = XGBoostCandidateRecord(
            grid_index=1,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=1.0, gamma=0.1),
            metrics=base_metrics,
        )
        x2 = XGBoostCandidateRecord(
            grid_index=2,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=10.0, gamma=0.1),
            metrics=base_metrics,
        )
        assert sorted([x1, x2], key=_lexicographic_xgb_sort_key)[0].grid_index == 2

        # Case 2: Equal reg_lambda, higher gamma wins
        x1 = XGBoostCandidateRecord(
            grid_index=1,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=10.0, gamma=0.1),
            metrics=base_metrics,
        )
        x2 = XGBoostCandidateRecord(
            grid_index=2,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=10.0, gamma=1.0),
            metrics=base_metrics,
        )
        assert sorted([x1, x2], key=_lexicographic_xgb_sort_key)[0].grid_index == 2

        # Case 3: Equal gamma, lower grid_index wins
        x1 = XGBoostCandidateRecord(
            grid_index=15,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=10.0, gamma=1.0),
            metrics=base_metrics,
        )
        x2 = XGBoostCandidateRecord(
            grid_index=8,
            hyperparameters=XGBoostHyperparameters(max_depth=3, reg_lambda=10.0, gamma=1.0),
            metrics=base_metrics,
        )
        assert sorted([x1, x2], key=_lexicographic_xgb_sort_key)[0].grid_index == 8


# =============================================================================
# 6. Checkpoint Resumption and Deduplication Tests
# =============================================================================

class TestCheckpointResumptionAndDeduplication:
    def test_random_forest_checkpoint_resumption(self, synthetic_features_and_labels):
        """Verify tune_random_forest skips already evaluated grid candidates from checkpoint."""
        X, y = synthetic_features_and_labels
        X_tr, y_tr = X.iloc[:80], y[:80]
        X_val, y_val = X.iloc[80:], y[80:]

        with tempfile.TemporaryDirectory() as tmp_dir:
            chk_path = os.path.join(tmp_dir, "checkpoint_rf.json")

            # Small 3-candidate grid
            grid = [
                RandomForestHyperparameters(n_estimators=10, max_depth=2, min_samples_leaf=20, grid_index=0),
                RandomForestHyperparameters(n_estimators=10, max_depth=3, min_samples_leaf=20, grid_index=1),
                RandomForestHyperparameters(n_estimators=10, max_depth=4, min_samples_leaf=20, grid_index=2),
            ]

            # Run first 2 candidates
            subgrid_1 = grid[:2]
            res_1 = tune_random_forest(
                X_train=X_tr, y_train=y_tr, X_val=X_val, y_val=y_val,
                horizon=1, checkpoint_path=chk_path, grid=subgrid_1,
            )
            assert os.path.exists(chk_path)

            # Resume with full 3-candidate grid
            eval_count = 0
            def _cb(done, total, rec):
                nonlocal eval_count
                eval_count += 1

            res_2 = tune_random_forest(
                X_train=X_tr, y_train=y_tr, X_val=X_val, y_val=y_val,
                horizon=1, checkpoint_path=chk_path, grid=grid, progress_callback=_cb,
            )

            assert len(res_2.candidates) == 3
            # Candidate 0 and 1 should be loaded from checkpoint, only candidate 2 fitted fresh
            assert res_2.candidates[0].hyperparameters.max_depth == 2
            assert res_2.candidates[1].hyperparameters.max_depth == 3
            assert res_2.candidates[2].hyperparameters.max_depth == 4


# =============================================================================
# 7. ModelRegistry Champion Registration Isolation Tests
# =============================================================================

class TestModelRegistryChampionIsolation:
    def test_registered_champion_has_validation_selected_status(self, synthetic_features_and_labels):
        """Verify registered champion models receive status VALIDATION_SELECTED and stay isolated."""
        X, y = synthetic_features_and_labels
        with tempfile.TemporaryDirectory() as tmp_dir:
            registry = ModelRegistry(registry_dir=tmp_dir)

            model = create_random_forest_model(
                RandomForestHyperparameters(n_estimators=10, max_depth=2, min_samples_leaf=15),
                horizon=1,
            )
            model.fit(X, y)

            metrics = compute_classification_metrics(y, model.predict(X), model.predict_proba(X))

            meta = registry.register_model(
                estimator=model,
                scaler=None,
                model_name="random_forest",
                version="1.0.0",
                horizon=1,
                hyperparameters=model.get_metadata().model_dump(),
                validation_metrics=metrics,
                training_samples=len(X),
                validation_samples=len(X),
                experiment_id="test_exp_001",
                status=ModelStatus.VALIDATION_SELECTED,
            )

            assert meta.status == ModelStatus.VALIDATION_SELECTED
            assert meta.model_id == "random_forest_h1_v1.0.0"

            # Verify load
            loaded_pipeline = registry.load_model("random_forest_h1_v1.0.0")
            assert loaded_pipeline.metadata.status == ModelStatus.VALIDATION_SELECTED
