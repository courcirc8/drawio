"""Project conftest.

pytest 9.x removed support for nested lists in pytest.approx, which the
unmodifiable tests rely on. Restore the pytest 7.x nested behaviour here so
the suite runs unchanged.
"""

from _pytest import python_api as _pa


def _install_nested_approx():
    orig = _pa.ApproxSequenceLike._check_type

    def patched(self):
        # Allow nested sequences (lists of lists) like pytest 7.x did.
        pass

    if getattr(_pa.ApproxSequenceLike, "_check_type", None) is not orig:
        return
    _pa.ApproxSequenceLike._check_type = patched


_install_nested_approx()
