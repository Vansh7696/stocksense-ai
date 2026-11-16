"""
StockSense AI — Model Registry Subpackage Facade
Exposes schemas, exceptions, and registry services for the ML package.
"""

from app.schemas.registry import (
    ModelStatus,
    ModelProvenance,
    ModelRegistryMetadata,
    ModelListItem,
)
from app.services.registry import (
    RegistryError,
    ArtifactNotFoundError,
    ArtifactIntegrityError,
    ModelVersionExistsError,
    IncompatibleFeatureError,
    IncompatibleClassError,
    RegistrySchemaVersionError,
    RuntimeCompatibilityError,
    RegisteredInferenceModel,
    ModelRegistry,
    register_selected_logistic_regression_models,
    check_runtime_compatibility,
    SUPPORTED_REGISTRY_SCHEMA_VERSIONS,
    TARGET_THRESHOLDS_PCT,
    SELECTED_LR_CANDIDATES,
)

__all__ = [
    "ModelStatus",
    "ModelProvenance",
    "ModelRegistryMetadata",
    "ModelListItem",
    "RegistryError",
    "ArtifactNotFoundError",
    "ArtifactIntegrityError",
    "ModelVersionExistsError",
    "IncompatibleFeatureError",
    "IncompatibleClassError",
    "RegistrySchemaVersionError",
    "RuntimeCompatibilityError",
    "RegisteredInferenceModel",
    "ModelRegistry",
    "register_selected_logistic_regression_models",
    "check_runtime_compatibility",
    "SUPPORTED_REGISTRY_SCHEMA_VERSIONS",
    "TARGET_THRESHOLDS_PCT",
    "SELECTED_LR_CANDIDATES",
]
