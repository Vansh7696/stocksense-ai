"""
StockSense AI — Classification Metrics Engine
Deterministic evaluation of 3-class stock return direction forecasting.
Target classes: DOWN (-1), NEUTRAL (0), UP (+1).
"""

from typing import Dict, List, Optional, Tuple, Any, Sequence, Union
import numpy as np

from app.schemas.metrics import (
    ClassMetricDetail,
    ConfusionMatrixData,
    CatastrophicErrorDetail,
    ClassificationMetrics,
)

# Canonical ordering and mappings
CLASS_LABELS: Tuple[int, int, int] = (-1, 0, 1)
CLASS_NAMES: Tuple[str, str, str] = ("DOWN", "NEUTRAL", "UP")

LABEL_TO_INDEX: Dict[int, int] = {-1: 0, 0: 1, 1: 2}
INDEX_TO_LABEL: Dict[int, int] = {0: -1, 1: 0, 2: 1}
LABEL_TO_NAME: Dict[int, str] = {-1: "DOWN", 0: "NEUTRAL", 1: "UP"}
NAME_TO_LABEL: Dict[str, int] = {"DOWN": -1, "NEUTRAL": 0, "UP": 1}
NAME_TO_INDEX: Dict[str, int] = {"DOWN": 0, "NEUTRAL": 1, "UP": 2}
INDEX_TO_NAME: Dict[int, str] = {0: "DOWN", 1: "NEUTRAL", 2: "UP"}

DEFAULT_EPSILON: float = 1e-15


def validate_classification_inputs(
    y_true: Union[Sequence[int], np.ndarray],
    y_pred: Union[Sequence[int], np.ndarray],
    y_prob: Optional[Union[Sequence[Sequence[float]], np.ndarray]] = None,
) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    """
    Validates array dimensions, data types, label allowlist, and probability invariants.

    Args:
        y_true: Ground-truth target labels. Must contain only {-1, 0, 1}.
        y_pred: Predicted target labels. Must contain only {-1, 0, 1}.
        y_prob: Optional predicted class probabilities of shape (N, 3).

    Returns:
        Tuple of (y_true_arr, y_pred_arr, y_prob_arr) as validated numpy arrays.

    Raises:
        ValueError: If lengths mismatch, inputs are empty, labels are unapproved,
                    or probability matrices are malformed.
    """
    # 1. Array conversion
    y_true_arr = np.asarray(y_true)
    y_pred_arr = np.asarray(y_pred)

    # 2. Emptiness check
    if y_true_arr.size == 0 or y_pred_arr.size == 0:
        raise ValueError("Cannot compute classification metrics on empty arrays (size=0).")

    # 3. Dimensionality check
    if y_true_arr.ndim != 1 or y_pred_arr.ndim != 1:
        raise ValueError(
            f"Labels must be 1D arrays: y_true.ndim={y_true_arr.ndim}, y_pred.ndim={y_pred_arr.ndim}."
        )

    # 4. Length equality
    if len(y_true_arr) != len(y_pred_arr):
        raise ValueError(
            f"Length mismatch: y_true has {len(y_true_arr)} samples, "
            f"y_pred has {len(y_pred_arr)} samples."
        )

    n_samples = len(y_true_arr)

    # 5. Label value validation
    # Check for NaN / Inf
    if not np.all(np.isfinite(y_true_arr)):
        raise ValueError("y_true contains non-finite values (NaN or Inf).")
    if not np.all(np.isfinite(y_pred_arr)):
        raise ValueError("y_pred contains non-finite values (NaN or Inf).")

    # Check allowed set {-1, 0, 1}
    allowed_labels = set(CLASS_LABELS)
    unique_true = set(np.unique(y_true_arr))
    unapproved_true = unique_true - allowed_labels
    if unapproved_true:
        raise ValueError(
            f"Unapproved labels detected in y_true: {sorted(list(unapproved_true))}. "
            f"Allowed labels: {list(CLASS_LABELS)}."
        )

    unique_pred = set(np.unique(y_pred_arr))
    unapproved_pred = unique_pred - allowed_labels
    if unapproved_pred:
        raise ValueError(
            f"Unapproved labels detected in y_pred: {sorted(list(unapproved_pred))}. "
            f"Allowed labels: {list(CLASS_LABELS)}."
        )

    y_true_int = y_true_arr.astype(np.int64)
    y_pred_int = y_pred_arr.astype(np.int64)

    # 6. Probability matrix validation
    y_prob_validated: Optional[np.ndarray] = None
    if y_prob is not None:
        y_prob_validated = validate_and_normalize_probabilities(y_prob, n_samples)

    return y_true_int, y_pred_int, y_prob_validated


def validate_and_normalize_probabilities(
    y_prob: Union[Sequence[Sequence[float]], np.ndarray],
    expected_samples: int,
) -> np.ndarray:
    """
    Validates probability matrix shape, non-negativity, finiteness, and positive row sums.
    Normalizes rows to strictly sum to 1.0.

    Class-column order is strictly:
        Index 0: DOWN (-1)
        Index 1: NEUTRAL (0)
        Index 2: UP (+1)

    Args:
        y_prob: 2D array-like of shape (N, 3).
        expected_samples: Expected row count N matching y_true.

    Returns:
        Normalized float64 probability array of shape (N, 3).

    Raises:
        ValueError: If shape is not (expected_samples, 3), contains NaN/Inf,
                    contains negative probabilities, or row sums are <= 0.
    """
    prob_arr = np.asarray(y_prob, dtype=np.float64)

    if prob_arr.ndim != 2:
        raise ValueError(
            f"Probability array must be 2-dimensional (got ndim={prob_arr.ndim}). "
            f"Expected shape ({expected_samples}, 3)."
        )

    if prob_arr.shape != (expected_samples, 3):
        raise ValueError(
            f"Probability matrix shape mismatch: got {prob_arr.shape}, "
            f"expected ({expected_samples}, 3)."
        )

    if not np.all(np.isfinite(prob_arr)):
        raise ValueError("Probability matrix contains non-finite values (NaN or Inf).")

    if np.any(prob_arr < 0.0):
        min_val = float(np.min(prob_arr))
        raise ValueError(
            f"Probability matrix contains negative values (minimum value: {min_val})."
        )

    row_sums = prob_arr.sum(axis=1, keepdims=True)
    if np.any(row_sums <= 0.0):
        zero_rows = np.where(row_sums.reshape(-1) <= 0.0)[0].tolist()
        raise ValueError(
            f"Probability rows with non-positive sum detected at row indices: {zero_rows[:5]}."
        )

    # Normalize rows to guarantee strict sum to 1.0
    prob_norm = prob_arr / row_sums
    return prob_norm


def compute_confusion_matrix(
    y_true: np.ndarray,
    y_pred: np.ndarray,
) -> np.ndarray:
    """
    Computes a 3x3 confusion matrix with fixed class order:
        Index 0: DOWN (-1)
        Index 1: NEUTRAL (0)
        Index 2: UP (+1)

    Row i = actual class, Column j = predicted class.

    Returns:
        3x3 numpy array of integer counts.
    """
    cm = np.zeros((3, 3), dtype=np.int64)
    r_indices = np.array([LABEL_TO_INDEX[int(v)] for v in y_true], dtype=np.int64)
    c_indices = np.array([LABEL_TO_INDEX[int(v)] for v in y_pred], dtype=np.int64)
    np.add.at(cm, (r_indices, c_indices), 1)
    return cm


def compute_catastrophic_error(
    cm: np.ndarray,
    total_samples: int,
) -> CatastrophicErrorDetail:
    """
    Computes catastrophic opposite-direction error:
    Actual DOWN (-1) predicted as UP (+1), or Actual UP (+1) predicted as DOWN (-1).

    Denominator:
        Primary rate: total_samples (all evaluated predictions N).
        Secondary subset rate: directional_samples_count (support_DOWN + support_UP).
    """
    down_to_up = int(cm[0, 2])
    up_to_down = int(cm[2, 0])
    catastrophic_count = down_to_up + up_to_down
    catastrophic_rate = float(catastrophic_count / total_samples) if total_samples > 0 else 0.0

    support_down = int(cm[0, :].sum())
    support_up = int(cm[2, :].sum())
    directional_samples = support_down + support_up

    directional_rate: Optional[float] = None
    if directional_samples > 0:
        directional_rate = float(catastrophic_count / directional_samples)

    return CatastrophicErrorDetail(
        count=catastrophic_count,
        rate=catastrophic_rate,
        down_to_up_count=down_to_up,
        up_to_down_count=up_to_down,
        total_samples=total_samples,
        directional_samples_count=directional_samples,
        directional_subset_rate=directional_rate,
    )


def compute_multiclass_log_loss(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    epsilon: float = DEFAULT_EPSILON,
) -> float:
    """
    Computes multiclass cross-entropy log loss.

    Formula:
        loss = - (1 / N) * sum_{i=1}^N sum_{k=0}^2 y_{i, k} * log(p_{i, k})

    Probability clipping:
        Probabilities are clipped to [epsilon, 1 - epsilon] and each row is
        renormalized to sum to 1.0 after clipping.

    Args:
        y_true: Validated 1D array of actual labels in {-1, 0, 1}.
        y_prob: Validated (N, 3) probability matrix.
        epsilon: Minimum probability floor.

    Returns:
        Log loss scalar (non-negative float).
    """
    n_samples = len(y_true)
    if n_samples == 0:
        raise ValueError("Cannot compute log loss on empty arrays.")

    eps = float(epsilon)
    p_clipped = np.clip(y_prob, eps, 1.0 - eps)
    p_norm = p_clipped / p_clipped.sum(axis=1, keepdims=True)

    # One-hot encode y_true
    y_onehot = np.zeros_like(p_norm, dtype=np.float64)
    for i, label in enumerate(y_true):
        y_onehot[i, LABEL_TO_INDEX[int(label)]] = 1.0

    log_p = np.log(p_norm)
    loss = -float(np.mean(np.sum(y_onehot * log_p, axis=1)))
    return max(0.0, loss)


def compute_brier_score(
    y_true: np.ndarray,
    y_prob: np.ndarray,
) -> float:
    """
    Computes the standard multiclass Brier score.

    Formula:
        Brier = mean( sum_{k=0}^2 (p_{i, k} - one_hot_{i, k})^2 )

    Range:
        [0.0, 2.0]
        - 0.0: Perfect forecast (100% confidence on correct class)
        - 2.0: Maximum possible error (100% confidence on incorrect class)

    Args:
        y_true: Validated 1D array of actual labels in {-1, 0, 1}.
        y_prob: Validated (N, 3) probability matrix.

    Returns:
        Standard multiclass Brier score in [0.0, 2.0].
    """
    n_samples = len(y_true)
    if n_samples == 0:
        raise ValueError("Cannot compute Brier score on empty arrays.")

    y_onehot = np.zeros_like(y_prob, dtype=np.float64)
    for i, label in enumerate(y_true):
        y_onehot[i, LABEL_TO_INDEX[int(label)]] = 1.0

    squared_errors = (y_prob - y_onehot) ** 2
    brier = float(np.mean(np.sum(squared_errors, axis=1)))
    return float(np.clip(brier, 0.0, 2.0))


def compute_classification_metrics(
    y_true: Union[Sequence[int], np.ndarray],
    y_pred: Union[Sequence[int], np.ndarray],
    y_prob: Optional[Union[Sequence[Sequence[float]], np.ndarray]] = None,
    horizon: Optional[int] = None,
    model_name: Optional[str] = None,
    epsilon: float = DEFAULT_EPSILON,
    metadata: Optional[Dict[str, Any]] = None,
) -> ClassificationMetrics:
    """
    Computes comprehensive, deterministic classification metrics for the 3-class problem.

    Zero-division behavior (fully explicit and documented):
        - Precision: 0.0 if TP + FP == 0 (class was never predicted).
        - Recall: 0.0 if TP + FN == 0 (class has 0 actual occurrences in support).
        - F1: 0.0 if Precision + Recall == 0.0.

    Balanced Accuracy vs. Macro Recall:
        - Balanced Accuracy: Average recall across classes actually present in y_true
          (i.e. classes with support > 0). Matches sklearn.metrics.balanced_accuracy_score.
        - Macro Recall: Unweighted arithmetic mean of recall across the entire fixed 3-class
          set [-1, 0, 1], assigning 0.0 recall to unobserved classes.
        - When all 3 classes are present in y_true, Balanced Accuracy == Macro Recall.
        - When classes are absent from y_true, Balanced Accuracy is greater than or equal to
          fixed three-class macro recall; strict inequality is not guaranteed (e.g., when
          all present class recalls are 0.0).

    Args:
        y_true: Actual labels in {-1, 0, 1}.
        y_pred: Predicted labels in {-1, 0, 1}.
        y_prob: Optional (N, 3) predicted probabilities (cols: DOWN, NEUTRAL, UP).
        horizon: Optional prediction horizon h in trading sessions (1, 3, 5).
        model_name: Optional model identifier string.
        epsilon: Probability clipping threshold for log loss.
        metadata: Optional dictionary of additional diagnostic metadata.

    Returns:
        ClassificationMetrics Pydantic container with all calculated metrics.
    """
    y_true_arr, y_pred_arr, y_prob_arr = validate_classification_inputs(y_true, y_pred, y_prob)
    n_samples = len(y_true_arr)

    # 1. Confusion Matrix
    cm = compute_confusion_matrix(y_true_arr, y_pred_arr)

    # 2. Per-class metrics
    per_class_metrics: Dict[str, ClassMetricDetail] = {}
    precisions: List[float] = []
    recalls: List[float] = []
    f1s: List[float] = []
    present_recalls: List[float] = []

    for idx, (lbl, name) in enumerate(zip(CLASS_LABELS, CLASS_NAMES)):
        tp = int(cm[idx, idx])
        fp = int(cm[:, idx].sum() - tp)
        fn = int(cm[idx, :].sum() - tp)
        support = int(cm[idx, :].sum())

        # Zero-division handling
        prec = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
        rec = float(tp / (tp + fn)) if (tp + fn) > 0 else 0.0
        f1 = float(2.0 * prec * rec / (prec + rec)) if (prec + rec) > 0.0 else 0.0

        precisions.append(prec)
        recalls.append(rec)
        f1s.append(f1)

        # Track recall for classes actually present in ground truth (support > 0)
        if support > 0:
            present_recalls.append(rec)

        per_class_metrics[name] = ClassMetricDetail(
            precision=prec,
            recall=rec,
            f1=f1,
            support=support,
        )

    # 3. Global macro metrics
    accuracy = float(np.trace(cm) / n_samples)
    macro_precision = float(np.mean(precisions))
    macro_recall = float(np.mean(recalls))
    macro_f1 = float(np.mean(f1s))
    # Balanced accuracy: unweighted mean of recall across classes actually present in y_true (support > 0).
    # Matches sklearn.metrics.balanced_accuracy_score.
    balanced_accuracy = float(np.mean(present_recalls)) if present_recalls else 0.0

    # 4. Catastrophic error
    catastrophic_error = compute_catastrophic_error(cm, n_samples)

    # 5. Probabilistic metrics
    log_loss_val: Optional[float] = None
    brier_val: Optional[float] = None

    if y_prob_arr is not None:
        log_loss_val = compute_multiclass_log_loss(y_true_arr, y_prob_arr, epsilon=epsilon)
        brier_val = compute_brier_score(y_true_arr, y_prob_arr)

    return ClassificationMetrics(
        accuracy=accuracy,
        balanced_accuracy=balanced_accuracy,
        macro_precision=macro_precision,
        macro_recall=macro_recall,
        macro_f1=macro_f1,
        per_class=per_class_metrics,
        confusion_matrix=cm.tolist(),
        catastrophic_error=catastrophic_error,
        log_loss=log_loss_val,
        brier_score=brier_val,
        total_samples=n_samples,
        horizon=horizon,
        model_name=model_name,
        metadata=metadata or {},
    )


class MetricsEngine:
    """
    Stateless evaluator engine encapsulating 3-class classification metrics.
    Reusable across h1, h3, h5, and across all model families.
    """

    def __init__(self, epsilon: float = DEFAULT_EPSILON):
        self.epsilon = float(epsilon)

    def evaluate(
        self,
        y_true: Union[Sequence[int], np.ndarray],
        y_pred: Union[Sequence[int], np.ndarray],
        y_prob: Optional[Union[Sequence[Sequence[float]], np.ndarray]] = None,
        horizon: Optional[int] = None,
        model_name: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ClassificationMetrics:
        """
        Calculates all classification metrics for given targets and predictions.
        """
        return compute_classification_metrics(
            y_true=y_true,
            y_pred=y_pred,
            y_prob=y_prob,
            horizon=horizon,
            model_name=model_name,
            epsilon=self.epsilon,
            metadata=metadata,
        )

    def compute_confusion_matrix_data(
        self,
        y_true: Union[Sequence[int], np.ndarray],
        y_pred: Union[Sequence[int], np.ndarray],
    ) -> ConfusionMatrixData:
        """
        Computes structured ConfusionMatrixData container.
        """
        y_true_arr, y_pred_arr, _ = validate_classification_inputs(y_true, y_pred)
        cm = compute_confusion_matrix(y_true_arr, y_pred_arr)
        return ConfusionMatrixData(matrix=cm.tolist())
