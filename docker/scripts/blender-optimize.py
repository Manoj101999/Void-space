"""Headless Blender export/optimisation for XR polycount budgets (FR-6.3).

Invoked as:
    blender --background --factory-startup --python blender-optimize.py -- \
        --input model.blend --output model.glb --budget 50000 --format glb

The script imports the source scene, decimates meshes that exceed the polycount
budget, then exports glTF/GLB. It prints a single JSON line prefixed with
`VOID_SPACE_RESULT ` so the worker can parse polycount/format without guessing.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import bpy  # type: ignore[import-not-found]  # provided by the Blender runtime


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser(description="VOID·SPACE Blender optimiser")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--budget", type=int, default=0, help="Target triangle budget (0 = no decimation)")
    parser.add_argument("--format", choices=["glb", "gltf"], default="glb")
    parser.add_argument("--generate-lods", action="store_true")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(path: str) -> None:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    elif ext in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    else:
        raise SystemExit(f"unsupported source format: {ext}")


def triangle_count() -> int:
    total = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
    return total


def decimate_to_budget(budget: int) -> int:
    """Apply a global-ish decimation pass; returns the resulting triangle count."""
    current = triangle_count()
    if budget <= 0 or current <= budget:
        return current

    ratio = max(0.05, min(1.0, budget / float(current)))
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        bpy.context.view_layer.objects.active = obj
        modifier = obj.modifiers.new(name="VoidSpaceDecimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return triangle_count()


def export(path: str, fmt: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if fmt == "glb":
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            export_apply=True,
            export_yup=True,
        )
    else:
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLTF_SEPARATE",
            export_apply=True,
            export_yup=True,
        )


def main() -> int:
    args = parse_args()
    try:
        clear_scene()
        import_source(args.input)
        before = triangle_count()
        after = decimate_to_budget(args.budget)
        export(args.output, args.format)
        print(
            "VOID_SPACE_RESULT "
            + json.dumps(
                {
                    "ok": True,
                    "input": args.input,
                    "output": args.output,
                    "format": args.format,
                    "trianglesBefore": before,
                    "trianglesAfter": after,
                    "budget": args.budget,
                }
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - surfaced to the worker as a job failure
        print("VOID_SPACE_RESULT " + json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
