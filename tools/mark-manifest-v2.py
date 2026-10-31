#!/usr/bin/env python3
"""Mark a built pbw as manifest v2 so the Pebble app lets it use plugins.

Apps whose appinfo.json lacks "manifestVersion": 2 are treated as legacy and
every Pebble.subscribeToSource() call fails with PERMISSION_DENIED. This adds
manifestVersion and usesPermissions (read from package.json) to appinfo.json,
leaving every other zip entry untouched (same as pack-plugin-pbw.py).

Usage: tools/mark-manifest-v2.py build/sundial.pbw [package.json]
"""
import json
import os
import sys
import tempfile
import zipfile


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__.strip().splitlines()[-1])
    pbw = sys.argv[1]
    pkg_path = sys.argv[2] if len(sys.argv) == 3 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "package.json")
    with open(pkg_path) as f:
        perms = json.load(f)["pebble"].get("usesPermissions", [])

    fd, tmp = tempfile.mkstemp(suffix=".pbw", dir=os.path.dirname(os.path.abspath(pbw)))
    os.close(fd)
    try:
        with zipfile.ZipFile(pbw) as src, zipfile.ZipFile(tmp, "w") as dst:
            for item in src.infolist():
                data = src.read(item.filename)
                if item.filename == "appinfo.json":
                    info = json.loads(data)
                    info["manifestVersion"] = 2
                    info["usesPermissions"] = perms
                    data = json.dumps(info, indent=4).encode()
                dst.writestr(item, data)
        os.replace(tmp, pbw)
    except BaseException:
        os.unlink(tmp)
        raise
    print("%s: manifestVersion 2, usesPermissions %s" % (pbw, perms))


if __name__ == "__main__":
    main()
