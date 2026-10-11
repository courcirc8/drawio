"""Fake of the real skillbridge client (stdlib only)."""

import fakevirtuoso as fv


def _snake_to_camel(name):
    return "".join(p.capitalize() for p in name.split("_"))


class Symbol:
    def __init__(self, name=None):
        self.name = name

    def __repr__(self):
        return "Symbol(%r)" % (self.name,)


class Key:
    def __init__(self, value=None):
        self.value = value

    def __repr__(self):
        return "Key(%r)" % (self.value,)


class _Namespace:
    def __init__(self, workspace, prefix):
        object.__setattr__(self, "_ws", workspace)
        object.__setattr__(self, "_prefix", prefix)

    def __getattr__(self, name):
        skill_name = self._prefix + _snake_to_camel(name)
        if skill_name not in fv.FUNCTIONS:
            raise AttributeError(skill_name)

        ws = self._ws

        def _call(*args, **kwargs):
            ws.calls.append((skill_name, args))
            return fv.FUNCTIONS[skill_name](*args, **kwargs)

        return _call


class Workspace:
    def __init__(self, workspace_id=None, direct=False):
        self.workspace_id = workspace_id
        self.direct = direct
        self.calls = []
        self._closed = False

    @classmethod
    def open(cls, workspace_id=None, direct=False):
        return cls(workspace_id=workspace_id, direct=direct)

    def __getattr__(self, name):
        # sub-namespaces like db, sch, dd map to SKILL function prefixes
        return _Namespace(self, name)

    def close(self):
        self._closed = True
