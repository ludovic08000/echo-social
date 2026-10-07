"""ForSure's offline recommender. Nothing in this package can publish a model."""
import os

# Bound native BLAS pools before importing NumPy on small developer machines.
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"
