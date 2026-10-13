# Bundled demo models

Two real scans, read from disk by the seed (`packages/db/src/seed-assets.ts`) and pinned to IPFS on
every `pnpm db:seed`. They are here rather than generated because a library of procedurally-built
cubes would look populated while proving nothing about how the platform behaves with production
assets — heavy geometry, dozens of textures, a 38-unit bounding box.

| File | Triangles | Vertices | Materials | Textures | Extent |
|---|---|---|---|---|---|
| `heart.glb` | 22,562 | 12,013 | 1 | 3 | 2.171 × 3.211 × 1.764 |
| `blue_whale_skeleton.glb` | 247,170 | 136,005 | 10 | 37 | 13.266 × 38.432 × 16.346 |

The seed **measures** these numbers from the file rather than trusting the table above, so the
polycount, vertex, material and texture counts shown in the UI are the artefact's own.

## Provenance

Both were exported from Sketchfab (`heart.glb` by Sketchfab 15.30.0, `blue_whale_skeleton.glb` by
15.58.0) and are used here as CC0 demo content.

## Why the whale is not the original export

`blue_whale_skeleton.glb` was re-exported to replace `KHR_materials_pbrSpecularGlossiness` with the
core `pbrMetallicRoughness` workflow. That extension is **deprecated and was removed from three.js**,
and the original file listed it in `extensionsRequired` — the glTF spec's way of saying a loader
*must* understand it or refuse the file. three.js does not refuse: it logs

```
THREE.GLTFLoader: Unknown extension "KHR_materials_pbrSpecularGlossiness".
```

and loads the geometry with default materials. The result was a whale skeleton rendering grey, with
all 28 textures silently discarded. Converting is the fix that travels: the asset now renders
correctly in three.js, Blender and any other conformant viewer, rather than needing each consumer to
carry a loader plugin for a dead extension.

```bash
npx @gltf-transform/cli@4 metalrough blue_whale_skeleton.glb blue_whale_skeleton.glb
```

Verified after conversion: triangles unchanged at **247,170**, 10 meshes, 10 materials preserved,
`extensionsRequired` gone, textures grown 28 → 37 (the conversion synthesises a metallicRoughness
map per material). The file grows 13.0 MB → 16.7 MB, which is the cost of that.

`heart.glb` needed no conversion — it declares no extensions and uses the core PBR workflow.
