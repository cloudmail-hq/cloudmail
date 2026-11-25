"""Deprecated alias for `cloudmail`.

The package was renamed: install `cloudmail` and write `import cloudmail`.
This shim re-exports everything, including the submodules
(`tapetide.webhooks`, `tapetide.errors`, ...), so old imports keep working.
It will be removed in a future release.
"""

import sys as _sys
import warnings as _warnings

import cloudmail as _cloudmail
from cloudmail import *  # noqa: F401,F403
from cloudmail import __all__, __version__  # noqa: F401
from cloudmail import client, errors, models, sse, webhooks  # noqa: F401

_warnings.warn(
    "The `tapetide` package is now `cloudmail`; use `import cloudmail`. "
    "The `tapetide` alias will be removed in a future release.",
    DeprecationWarning,
    stacklevel=2,
)

for _name in ("client", "errors", "models", "sse", "webhooks", "_version"):
    _sys.modules[f"{__name__}.{_name}"] = _sys.modules[f"{_cloudmail.__name__}.{_name}"]
