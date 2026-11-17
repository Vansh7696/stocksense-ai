# StockSense AI — Phase 5C.4.2: Advanced ML Model Implementation

**Document Reference:** `docs/phase-5c4-2-advanced-model-implementation.md`<br>
**Phase:** Phase 5C.4.2 — Advanced ML Model Implementation (Revision 1.1.0 — Post-Audit Targeted Corrections)<br>
**Branch:** `feature/phase-5c-ml-training`<br>
**Git HEAD:** `643d6919dd5409e5755955282617bef8607a63ad`<br>
**Date:** November 17, 2026<br>
**Status:** **IMPLEMENTED, DEFECT-CORRECTED & AUDITED (ALL 297 TESTS PASSING)**

---

## 1. Executive Summary

Following the formal approval of the **Phase 5C.4.1 Research & Design Specification (Revision 3.1.0)**, Phase 5C.4.2 delivers the complete software engineering implementation of the two approved non-linear machine learning model families for StockSense AI:

1. **Random Forest Classifier** (`RandomForestModel` wrapping `sklearn.ensemble.RandomForestClassifier`): Canonical non-linear bagging ensemble architecture that stabilizes variance via tree bootstrap aggregation and feature subspace sampling.
2. **XGBoost Classifier** (`XGBoostModel` wrapping `xgboost.XGBClassifier`): Regularized second-order gradient-boosted decision tree ensemble supporting nested inner validation early stopping, tree pruning penalties ($\gamma$), leaf weight $L_2$ regularization ($\lambda$), and row/column subsampling.

Both model families are fully integrated into the existing, cryptographically audited **Model Registry** infrastructure (`RegisteredInferenceModel` and `ModelRegistry` in `ml-service/app/services/registry.py`), maintaining strict backwards compatibility with the linear Logistic Regression baseline.

### Core Implementation Achievements
- **Dual-Model Factory & Hyperparameter Grid Engines:**
  - Implemented `RandomForestModel` with exact 108 candidate configurations per horizon ($3 \times 4 \times 3 \times 3$).
  - Implemented `XGBoostModel` with exact 162 candidate configurations per horizon ($3 \times 3 \times 2 \times 3 \times 3$) and inner `eval_set` early stopping support.
  - Total formal experiment budget of **810 configurations** across $h \in \{1, 3, 5\}$ defined in immutable Pydantic schemas.
- **Direct Raw Feature Ingestion (`scaler=None`):**
  - Decision tree splitting criteria ($x_j \le \tau$) are rank-invariant under strictly monotonic transformations. The `RegisteredInferenceModel` interface and `ModelRegistry` now support `scaler=None`, directly ingesting the approved 23 technical features without `StandardScaler` overhead or scaling distortion, while preserving Logistic Regression's train-only `StandardScaler` pipeline without modification.
- **Unified 3-Class Label & Probability Alignment (Audit Fix B.1):**
  - External labels $\{-1, 0, 1\}$ (DOWN, NEUTRAL, UP) map dynamically and deterministically to contiguous internal indices $\{0, \dots, K-1\}$ for training. When training folds contain only 2 classes (e.g. $\{-1, 1\}$, $\{-1, 0\}$, or $\{0, 1\}$), XGBoost's contiguous class requirement is strictly satisfied without non-contiguous indexing failures. Single-class folds fail fast with a domain `ValueError`.
  - Probability output matrices are guaranteed to be of shape $(N, 3)$ strictly ordered $[P(\text{DOWN}), P(\text{NEUTRAL}), P(\text{UP})]$ with rows summing to $1.0$. Unobserved classes receive exact $0.0$ probability with remaining classes calibrated and normalized.
- **Strict 23-Feature Schema Governance & Duplicate Detection (Audit Fix C.1):**
  - Enforces exact feature column presence, column reordering immunity, rejection of missing or unexpected extra columns, rejection of duplicate column names, 2D array dimension validation, and finite value checks (no NaN, Inf).
- **Cryptographic Provenance & Runtime Compatibility (Audit Fix C.2):**
  - `ModelRegistry` records installed library versions including `xgboost` in `ModelProvenance`.
  - `check_runtime_compatibility()` strictly verifies XGBoost major.minor version match when deserializing XGBoost models, preventing incompatible cross-minor deserialization.
- **Inner Validation Evaluation Guards (Audit Fix C.3):**
  - Validates `eval_set` target labels against approved canonical labels $\{-1, 0, 1\}$.
  - Rejects evaluation targets containing classes not observed in the training partition, preventing silent unmapped class index lookups.
- **Dependency Guard & Dynamic Library Error Chaining (Audit Fix B.2):**
  - Catches dynamic library loader errors (e.g. `XGBoostError` when OpenMP `libomp.dylib` is missing) and chains the underlying cause into `XGBoostDependencyError`.
- **Comprehensive Test Suite & Zero Regressions:**
  - 43 dedicated unit and integration tests in `ml-service/tests/test_advanced_models.py`.
  - Complete ML test suite passes with **297 passed tests (100% pass rate)**.
- **Strict Data Quarantine & Zero Model Training:**
  - Zero models were trained, tuned, or evaluated on the canonical historical dataset (`historical_candles_5stocks.json`) during this phase. All verification was conducted on isolated synthetic fixtures.
  - The held-out Phase 5C.3 test partition was never accessed.
- **Environment & Dependency Status:**
  - `Python 3.14.9` verified and active.
  - `scikit-learn==1.9.1` verified and active.
  - `xgboost==3.4.1` verified and active with OpenMP runtime.

---

## 2. Architecture & Component Structure

Phase 5C.4.2 follows StockSense AI's three-tier design pattern: **Schemas**, **Domain Services**, and **ML Facades**, mirroring the approved baseline architecture.

```
ml-service/
├── app/
│   ├── schemas/
│   │   ├── random_forest.py       # Pydantic V2 schemas for RF hyperparams, candidate records, tuning results, metadata
│   │   ├── xgboost_model.py       # Pydantic V2 schemas for XGB hyperparams, candidate records, tuning results, metadata
│   │   └── registry.py            # ModelRegistryMetadata updated with optional solver and tree metadata
│   ├── services/
│   │   ├── random_forest.py       # RandomForestModel service, search grid generator, model factory
│   │   ├── xgboost_model.py       # XGBoostModel service, search grid generator, model factory, inner early stopping
│   │   └── registry.py            # ModelRegistry and RegisteredInferenceModel supporting scaler=None
│   └── ml/
│       ├── __init__.py            # ML package entry point exposing all modules
│       ├── random_forest.py       # ML facade re-exporting RF services and schemas
│       └── xgboost_model.py       # ML facade re-exporting XGBoost services and schemas
└── tests/
    └── test_advanced_models.py    # Comprehensive test suite covering RF, XGBoost, registry integration
```

---

## 3. Detailed Component Specifications

### 3.1 Random Forest Implementation

- **Service Module:** `ml-service/app/services/random_forest.py`
- **Schema Module:** `ml-service/app/schemas/random_forest.py`
- **Facade Module:** `ml-service/app/ml/random_forest.py`

#### A. Domain Service (`RandomForestModel`)
Wraps `sklearn.ensemble.RandomForestClassifier` with deterministic configurations:
- **Direct Feature Processing:** Accepts `pandas.DataFrame` or `numpy.ndarray` containing the approved 23 technical features without scaling.
- **Deterministic Random Seed:** Enforces `random_state=42` across all candidate initializations and tree bootstraps.
- **Multi-threaded Fitting:** Defaults to `n_jobs=-1` for parallel tree construction across available CPU cores.
- **Class Mapping:** Translates external labels $\{-1, 0, 1\}$ to internal classes $\{0, 1, 2\}$ via `EXTERNAL_TO_INTERNAL = {-1: 0, 0: 1, 1: 2}` and maps predictions back via `INTERNAL_TO_EXTERNAL = {0: -1, 1: 0, 2: 1}`.
- **Probability Normalization:** Maps raw estimator probabilities to canonical 3-class distribution $[P(\text{DOWN}), P(\text{NEUTRAL}), P(\text{UP})]$ using `validate_and_normalize_probabilities`.
- **Model Metadata Extraction:** Exposes `get_metadata() -> RandomForestModelMetadata` reporting fitted feature importances per feature name.

#### B. Hyperparameter Search Grid (`get_random_forest_search_grid`)
Generates exactly **108 configurations** per horizon:
- `n_estimators`: $\{100, 200, 300\}$ (3 options)
- `max_depth`: $\{3, 4, 5, 6\}$ (4 options)
- `min_samples_leaf`: $\{15, 25, 40\}$ (3 options)
- `max_features`: $\{\text{"sqrt"}, \text{"log2"}, 0.3\}$ (3 options)
- **Fixed Parameters:** `class_weight=None`, `bootstrap=True`, `random_state=42`
- **Per-Horizon Configurations:** $3 \times 4 \times 3 \times 3 = 108$
- **Three-Horizon Total ($h \in \{1, 3, 5\}$):** $108 \times 3 = \mathbf{324}$ configurations.

---

### 3.2 XGBoost Implementation

- **Service Module:** `ml-service/app/services/xgboost_model.py`
- **Schema Module:** `ml-service/app/schemas/xgboost_model.py`
- **Facade Module:** `ml-service/app/ml/xgboost_model.py`

#### A. Domain Service (`XGBoostModel`)
Wraps `xgboost.XGBClassifier` with enterprise safety and dependency containment:
- **Dependency Guard & Library Error Chaining:** Conditionally imports `xgboost`. Catches dynamic loader errors (such as missing `libomp.dylib` on macOS) and missing package imports, storing the root exception and raising `XGBoostDependencyError` on instantiation or fit if unavailable.
- **Nested Inner Early Stopping:** In strict adherence to Section 5.1 of the design specification, `fit()` accepts an optional `eval_set` (containing the nested inner validation split) with `early_stopping_rounds=15`. It tracks `best_iteration_` dynamically, preventing outer validation set leakage.
- **Evaluation Set Validation Guard:** `eval_set` targets are validated against approved labels $\{-1, 0, 1\}$. Targets containing classes absent from the training partition are rejected with `ValueError`, preventing indexing failures during evaluation.
- **Dynamic Contiguous Class Remapping:** Maps observed external labels to contiguous internal indices $\{0, \dots, K-1\}$. Prevents `ValueError: Invalid classes inferred from unique values of y. Expected: [0 1], got [0 2]` when training subsets miss intermediate classes (e.g. $\{-1, 1\}$). Rejects single-class partitions ($K < 2$).
- **Probability Alignment & Normalization:** Translates internal prediction probabilities back to the canonical 3-class distribution $[P(\text{DOWN}), P(\text{NEUTRAL}), P(\text{UP})]$ of shape $(N, 3)$. Assigns exact $0.0$ to unobserved classes and normalizes using `validate_and_normalize_probabilities`.
- **Objective & Multi-Class Specification:** Configured with `objective="multi:softprob"`, `num_class=n_classes`, `eval_metric="mlogloss"`, and `tree_method="hist"` for rapid histogram-based split building. Handles both 1D and 2D raw prediction outputs when $K=2$.

#### B. Hyperparameter Search Grid (`get_xgboost_search_grid`)
Generates exactly **162 configurations** per horizon:
- `learning_rate` ($\eta$): $\{0.01, 0.03, 0.05\}$ (3 options)
- `max_depth`: $\{2, 3, 4\}$ (3 options)
- `subsample`: $\{0.7, 0.85\}$ (2 options)
- `reg_lambda` ($\lambda$): $\{1.0, 5.0, 10.0\}$ (3 options)
- `gamma` ($\gamma$): $\{0.1, 0.5, 1.0\}$ (3 options)
- **Fixed Parameters:**
  - `colsample_bytree`: $0.8$
  - `min_child_weight`: $15.0$ (reflecting multi-class Hessian scale $h_{ik} \le 0.25$, requiring $\approx 60$ effective observations per leaf)
  - `objective`: `"multi:softprob"`, `num_class`: $3$, `eval_metric`: `"mlogloss"`
  - `n_estimators`: $200$ (capped upper bound, pruned by inner early stopping with patience $15$)
  - `random_state`: $42$
- **Per-Horizon Configurations:** $3 \times 3 \times 2 \times 3 \times 3 = 162$
- **Three-Horizon Total ($h \in \{1, 3, 5\}$):** $162 \times 3 = \mathbf{486}$ configurations.

#### C. Comprehensive Experiment Search Budget
$$\text{Total Search Space Budget} = (108_{\text{RF}} + 162_{\text{XGB}}) \times 3_{\text{horizons}} = \mathbf{810 \text{ configurations}}$$

---

### 3.3 Model Registry & Inference Pipeline Integration

- **Service Module:** `ml-service/app/services/registry.py`
- **Schema Module:** `ml-service/app/schemas/registry.py`

#### A. Direct Feature Processing with `scaler=None`
In `RegisteredInferenceModel`:
```python
def _validate_and_scale(self, X: Union[pd.DataFrame, np.ndarray]) -> np.ndarray:
    # 1. Feature verification and column reordering
    ...
    # 2. Finite checks (NaN, Inf rejection)
    ...
    # 3. Conditional scaling
    if self.scaler is not None:
        scaled = self.scaler.transform(X_ordered)
        return scaled
    return X_ordered
```
When `scaler=None`, raw feature values pass directly to the estimator without transformation or computational overhead. When `scaler` is a fitted `StandardScaler`, standardization is applied identically to Phase 5C.3.

#### B. Feature Schema Validation & Reordering Immunity
- **Permuted Column Robustness:** Incoming DataFrames with approved features in arbitrary column order are reordered to match `self.feature_names` exactly before evaluation.
- **Missing Feature Rejection:** Raises `IncompatibleFeatureError` if any approved feature column is absent.
- **Unexpected Feature Rejection:** Raises `IncompatibleFeatureError` if extraneous columns are present.
- **Dimension Check:** Rejects 2D `ndarray` inputs whose second dimension does not equal 23.
- **Finiteness Check:** Rejects inputs with `NaN` or `Inf` values.

#### C. Probability Mapping & Normalization
If an estimator observed fewer than 3 classes during training (e.g. classes 0 and 2 only):
```python
aligned_probs = np.zeros((len(X_proc), 3), dtype=np.float64)
is_external = any(c < 0 for c in est_classes)
for idx, cls in enumerate(est_classes):
    col_idx = EXTERNAL_TO_INTERNAL.get(int(cls)) if is_external else int(cls)
    aligned_probs[:, col_idx] = raw_probs[:, idx]
return validate_and_normalize_probabilities(aligned_probs, expected_samples=len(X_proc))
```
Missing classes receive $0.0$ probability and row sums are normalized to $1.0$, preventing runtime indexing errors or misaligned directional predictions.

#### D. ModelRegistry Atomic Registration & Deserialization
- **Atomic Persistence:** Writes serialized bundle (`estimator`, `scaler`, `feature_names`, `class_labels`, `metadata`) and `metadata.json` sidecar to a filesystem-isolated staging directory, publishing via POSIX atomic `os.replace`.
- **Flexible Estimator Inspection:** `is_estimator_fitted()` detects fitted state across domain wrappers (`self.is_fitted_`) and native scikit-learn / XGBoost estimators (`classes_`, `estimators_`, `n_features_in_`).
- **Cryptographic Verification:** Verifies SHA-256 digest prior to deserializing any local artifact.
- **Bit-for-Bit Parity:** Test suite confirms `np.testing.assert_allclose(probs_orig, probs_loaded, atol=1e-12)` across serializations.

---

## 4. Verification & Testing

### 4.1 Dedicated Advanced Model Test Suite (`test_advanced_models.py`)
A dedicated test file containing 43 comprehensive tests was created, verified, and audited across 6 test classes:

| Test Class | Test Case | Purpose / Assertion | Status |
|---|---|---|:---:|
| `TestRandomForestSpecificationAndGrid` | `test_search_grid_exact_108_candidates` | Confirms exactly 108 unique configurations ($3 \times 4 \times 3 \times 3$) with sequential indices $0..107$ | **PASS** |
| | `test_search_grid_parameter_values` | Verifies parameter values match approved Phase 5C.4.1 design | **PASS** |
| | `test_hyperparameters_schema_validation` | Rejects invalid configurations ($n_{\text{est}} \le 0$, $\text{depth} \le 0$) | **PASS** |
| | `test_create_random_forest_model_factory` | Confirms factory creates correctly configured `RandomForestModel` | **PASS** |
| `TestRandomForestModelFitting` | `test_rf_fit_predict_proba_synthetic` | Verifies fitting, prediction $\in \{-1, 0, 1\}$, and probability shape $(N, 3)$ summing to $1.0$ | **PASS** |
| | `test_rf_missing_class_resilience` | Missing class receives $0.0$ probability; active classes sum to $1.0$ | **PASS** |
| | `test_rf_rejects_unapproved_labels` | Rejects non-canonical labels (e.g. 99) with `ValueError` | **PASS** |
| | `test_rf_rejects_non_finite_inputs` | Rejects `NaN` and `Inf` in feature inputs | **PASS** |
| | `test_rf_predict_before_fit_raises` | Rejects inference on unfitted model | **PASS** |
| | `test_rf_single_class_raises` | Rejects training partitions containing $< 2$ classes | **PASS** |
| | `test_rf_duplicate_columns_rejected` | Rejects input DataFrames with duplicate column names | **PASS** |
| `TestXGBoostSpecificationAndGrid` | `test_search_grid_exact_162_candidates` | Confirms exactly 162 unique configurations ($3 \times 3 \times 2 \times 3 \times 3$) with sequential indices $0..161$ | **PASS** |
| | `test_search_grid_parameter_values` | Verifies parameter values match approved Phase 5C.4.1 design | **PASS** |
| | `test_hyperparameters_schema_validation` | Rejects invalid configurations ($\eta \le 0$) | **PASS** |
| | `test_create_xgboost_model_factory` | Confirms factory creates correctly configured `XGBoostModel` | **PASS** |
| | `test_xgboost_dependency_or_execution` | Tests graceful dependency guard raising `XGBoostDependencyError` | **PASS** |
| `TestXGBoostModelFitting` | `test_xgboost_fit_predict_proba_synthetic` | Verifies fitting, prediction $\in \{-1, 0, 1\}$, and probability shape $(N, 3)$ summing to $1.0$ | **PASS** |
| | `test_xgboost_early_stopping_inner_val` | Verifies inner validation `eval_set` captures `best_iteration_` | **PASS** |
| | `test_xgboost_missing_class_down_up` | Folds missing NEUTRAL (0) map cleanly, col 1 is $0.0$, rows sum to $1.0$ | **PASS** |
| | `test_xgboost_missing_class_down_neutral` | Folds missing UP (+1) map cleanly, col 2 is $0.0$, rows sum to $1.0$ | **PASS** |
| | `test_xgboost_missing_class_neutral_up` | Folds missing DOWN (-1) map cleanly, col 0 is $0.0$, rows sum to $1.0$ | **PASS** |
| | `test_xgboost_single_class_raises` | Partitions with $< 2$ distinct classes fail fast with domain `ValueError` | **PASS** |
| | `test_xgboost_eval_set_validation_unapproved_label` | Rejects unapproved evaluation labels in `eval_set` | **PASS** |
| | `test_xgboost_eval_set_validation_unseen_class` | Rejects evaluation targets with classes absent in training partition | **PASS** |
| | `test_xgboost_eval_set_validation_mismatched_length` | Rejects length mismatches between eval features and targets | **PASS** |
| | `test_xgboost_metadata` | Audit metadata contains 23 feature importances and fitted parameters | **PASS** |
| | `test_xgboost_duplicate_columns_rejected` | Rejects feature DataFrames with duplicate column names | **PASS** |
| | `test_xgboost_predict_before_fit_raises` | Rejects inference on unfitted XGBoost model | **PASS** |
| `TestRegisteredInferenceModelTreeIntegration` | `test_inference_model_with_scaler_none` | Verifies direct raw feature pass-through when `scaler=None` | **PASS** |
| | `test_feature_column_reordering_immunity` | Permuting column order produces bit-for-bit identical predictions | **PASS** |
| | `test_rejects_missing_features` | DataFrame missing features raises `IncompatibleFeatureError` | **PASS** |
| | `test_rejects_unexpected_features` | DataFrame with extra features raises `IncompatibleFeatureError` | **PASS** |
| | `test_rejects_wrong_array_dimension` | Array with $\ne 23$ columns raises `IncompatibleFeatureError` | **PASS** |
| | `test_rejects_duplicate_column_names` | Input DataFrame with duplicate column names raises `IncompatibleFeatureError` | **PASS** |
| | `test_rejects_mismatched_column_count` | Input DataFrame with $\ne 23$ columns raises `IncompatibleFeatureError` | **PASS** |
| `TestModelRegistryAdvancedModelsIntegration` | `test_register_and_load_random_forest_scaler_none` | Complete save/load cycle with `scaler=None`; bit-for-bit prediction parity | **PASS** |
| | `test_register_and_load_xgboost_scaler_none` | Complete save/load cycle for XGBoost with `scaler=None`; bit-for-bit parity | **PASS** |
| | `test_tampered_artifact_fails_integrity` | Cryptographic SHA-256 mismatch on RF raises `ArtifactIntegrityError` | **PASS** |
| | `test_xgboost_tampered_artifact_fails_integrity` | Cryptographic SHA-256 mismatch on XGB raises `ArtifactIntegrityError` | **PASS** |
| | `test_xgboost_provenance_records_installed_version` | Verifies `xgboost` version recorded in model provenance metadata | **PASS** |
| | `test_incompatible_xgboost_runtime_version_rejected` | Cross-minor XGBoost runtime mismatch raises `RuntimeCompatibilityError` | **PASS** |
| | `test_optional_xgboost_failure_does_not_break_random_forest` | RF and registry continue functioning even when XGBoost is unavailable | **PASS** |
| | `test_coexistence_with_scaled_logistic_regression` | Scaled LR and unscaled RF coexist in registry and predict concurrently | **PASS** |

### 4.2 Full Regression Test Suite Run
The entire ML service test suite was executed:
```bash
PYTHONPATH=ml-service DYLD_LIBRARY_PATH=/usr/local/lib ./ml-service/.venv314/bin/pytest ml-service/tests/
```
**Results:**
- Total tests executed: **297**
- Total passed: **297 (100%)**
- Failures: **0**
- Execution time: **46.33 seconds**

---

## 5. Governance, Quarantine & Dependency Audit

### 5.1 Test Partition Quarantine
- In accordance with architectural governance rules, the Phase 5C.3 held-out test partition ($N_{\text{te}} \in \{410, 400, 390\}$) was **never accessed, loaded, or evaluated**.
- No experimentation, hyperparameter tuning, or validation benchmarking was performed on the test partition.

### 5.2 Zero Historical Data Fitting in Phase 5C.4.2
- `historical_candles_5stocks.json` was not loaded for fitting or evaluation in this implementation phase.
- All unit tests and integration tests use deterministic, synthetic fixtures created on-the-fly (`RandomState(42)`).

### 5.3 Python Package & Dependency Status
- **Python Runtime:** Python 3.14.9 (macOS arm64).
- **Installed Packages:**
  - `scikit-learn`: 1.9.1 (verified)
  - `xgboost`: 3.4.1 (verified with OpenMP runtime `/usr/local/lib/libomp.dylib`)
  - `numpy`: 2.3.4 (verified)
  - `pandas`: 2.3.3 (verified)
  - `scipy`: 1.16.2 (verified)
  - `joblib`: 1.5.2 (verified)
  - `pydantic`: 2.14.0 (verified)
- **Dependency Guard & OpenMP Runtime:**
  - `xgboost` 3.4.1 is fully installed in `.venv314` and dynamically links to macOS OpenMP runtime via `DYLD_LIBRARY_PATH=/usr/local/lib`.
  - The software architecture handles missing library binaries cleanly: dynamic loader errors are caught and chained into `XGBoostDependencyError`.

---

## 6. Git Status & Working Tree Integrity

In strict adherence to the execution instructions, **no files were staged, committed, pushed, or merged**.

### Modified / Created Files
```
Untracked / New Files:
  docs/phase-5c4-1-advanced-ml-model-research-and-design.md
  docs/phase-5c4-2-advanced-model-implementation.md
  ml-service/app/ml/random_forest.py
  ml-service/app/ml/xgboost_model.py
  ml-service/app/schemas/random_forest.py
  ml-service/app/schemas/xgboost_model.py
  ml-service/app/services/random_forest.py
  ml-service/app/services/xgboost_model.py
  ml-service/tests/test_advanced_models.py

Modified Files:
  ml-service/app/ml/__init__.py
  ml-service/app/schemas/registry.py
  ml-service/app/services/registry.py
```

### Git Command Status
- **Current branch:** `feature/phase-5c-ml-training`
- **Latest approved commit:** `643d6919dd5409e5755955282617bef8607a63ad`
- **Working Tree:** Contains only the intended Phase 5C.4.2 implementation and documentation deliverables. Zero `.joblib`, `.env`, secrets, or temporary artifacts are present.

---

## 7. Next Steps: Phase 5C.4.3 (Validation-Set Tuning)

Upon user review and approval of Phase 5C.4.2:
1. Environment preparation: install `xgboost` into `ml-service/.venv` via sanctioned channel.
2. Implement the Phase 5C.4.3 tuning engine to execute the approved 810-configuration search space across $h \in \{1, 3, 5\}$ on the training partition ($N_{\text{tr}} \in \{1,885, 1,875, 1,865\}$) using the outer validation partition ($N_{\text{val}} \in \{465, 455, 445\}$) strictly for model selection.
3. Enforce lexicographical candidate selection policy (Balanced Accuracy $\rightarrow$ Macro F1 $\rightarrow$ Validation Log Loss $\rightarrow$ Grid Index).
4. Persist selected champion models into the Model Registry under status `VALIDATION_SELECTED`.
5. Maintain strict quarantine of the Phase 5C.3 test partition.
