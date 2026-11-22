"""
Headless Blender script to pre-render SuperTuxKart podium assets:
  - podium.png                (1200x675 transparent 3D championship podium)
  - karts/<kart_id>_{1,2,3}.png (transparent 3D kart renders with contact shadows)
  - layout.json               (exact projected pixel coordinates for 2D compositing)

Usage:
  blender --background --python render_podium_assets.py -- \
      --stk-assets /assets --out-dir /out [--karts tux,nolok,hexley] [--samples 32]
"""

import argparse
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from spm_importer import load_kart_into_blender

CANVAS_W = 1200
CANVAS_H = 675

# Pedestal geometry in Blender meters (X right, Y forward/depth, Z up).
# Camera sits on -Y looking toward +Y.
PEDESTALS = {
    "1": {
        "rank": 1,
        "x": 0.0,
        "width": 1.84,
        "depth": 1.55,
        "height": 1.58,
        "trim_color": (0.96, 0.72, 0.06, 1.0),  # Gold
        "kart_size": (460, 360),
        "kart_yaw_deg": 20.0,
        "kart_cam_dist": 4.25,
        "kart_scale_target": 1.38,
    },
    "2": {
        "rank": 2,
        "x": -1.86,
        "width": 1.62,
        "depth": 1.45,
        "height": 1.22,
        "trim_color": (0.78, 0.83, 0.90, 1.0),  # Silver
        "kart_size": (400, 320),
        "kart_yaw_deg": 32.0,
        "kart_cam_dist": 4.55,
        "kart_scale_target": 1.28,
    },
    "3": {
        "rank": 3,
        "x": 1.86,
        "width": 1.62,
        "depth": 1.45,
        "height": 0.98,
        "trim_color": (0.82, 0.49, 0.22, 1.0),  # Bronze
        "kart_size": (400, 320),
        "kart_yaw_deg": -32.0,
        "kart_cam_dist": 4.55,
        "kart_scale_target": 1.28,
    },
}


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    p = argparse.ArgumentParser(description="Render STK 3D podium & kart PNG assets")
    p.add_argument("--stk-assets", default="/assets", help="Path to stk-assets checkout")
    p.add_argument("--stk-data", default="", help="Optional path to stk-code/data for shared textures")
    p.add_argument("--out-dir", default="/out", help="Output directory for PNGs and layout.json")
    p.add_argument("--karts", default="", help="Comma-separated kart IDs to render (empty = all)")
    p.add_argument("--only-podium", action="store_true", help="Only render podium.png and layout.json")
    p.add_argument("--skip-podium", action="store_true", help="Skip podium.png render")
    p.add_argument("--samples", type=int, default=64, help="Cycles render samples (default: 64)")
    return p.parse_args(argv)


def reset_scene(samples):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.cycles.transparent_max_bounces = 8

    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.compression = 15

    # Crisp, vivid color management
    scene.view_settings.view_transform = "AgX" if "AgX" in [
        i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items
    ] else "Filmic"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.15

    # Soft studio world fill
    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.38, 0.42, 0.50, 1.0)
        bg.inputs["Strength"].default_value = 0.65

    return scene


def add_studio_lights():
    def _area(name, loc, target, energy, size, color):
        data = bpy.data.lights.new(name=name, type="AREA")
        data.energy = energy
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name=name, object_data=data)
        obj.location = loc
        direction = Vector(target) - Vector(loc)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        bpy.context.collection.objects.link(obj)
        return obj

    # Warm key light (front-right-top)
    _area("KeyLight", (4.5, -5.5, 6.0), (0.0, 0.0, 1.2), energy=900.0, size=3.5, color=(1.0, 0.96, 0.90))
    # Cool fill light (front-left)
    _area("FillLight", (-5.0, -4.5, 3.8), (0.0, 0.0, 1.0), energy=360.0, size=4.0, color=(0.82, 0.90, 1.0))
    # Rim light (back-top) to pop silhouettes against track backdrops
    _area("RimLight", (0.0, 5.2, 5.5), (0.0, 0.0, 1.4), energy=550.0, size=4.5, color=(0.92, 0.96, 1.0))


def add_camera(name, loc, target, lens=62.0):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.clip_start = 0.05
    cam_data.clip_end = 100.0
    cam_obj = bpy.data.objects.new(name, cam_data)
    cam_obj.location = loc
    direction = Vector(target) - Vector(loc)
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    return cam_obj


def make_bsdf_material(name, color, metallic=0.0, roughness=0.4):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def add_beveled_box(name, size_xyz, center_xyz, material, bevel_width=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center_xyz)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size_xyz
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bev = obj.modifiers.new(name="Bevel", type="BEVEL")
    bev.width = bevel_width
    bev.segments = 3
    bev.limit_method = "NONE"

    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return obj


def project_to_pixel(scene, cam_obj, world_pt, res_w, res_h):
    co = world_to_camera_view(scene, cam_obj, Vector(world_pt))
    return (co.x * res_w, (1.0 - co.y) * res_h)


def render_podium(out_dir, samples):
    scene = reset_scene(samples)
    scene.render.resolution_x = CANVAS_W
    scene.render.resolution_y = CANVAS_H
    scene.render.resolution_percentage = 100

    add_studio_lights()

    body_mat = make_bsdf_material("PodiumBody", (0.022, 0.030, 0.058, 1.0), metallic=0.16, roughness=0.38)
    plinth_mat = make_bsdf_material("PodiumPlinth", (0.012, 0.016, 0.032, 1.0), metallic=0.22, roughness=0.44)

    cap_thick = 0.085
    plinth_h = 0.07

    for key, spec in PEDESTALS.items():
        w = spec["width"]
        d = spec["depth"]
        h = spec["height"]
        x = spec["x"]

        # Base plinth
        add_beveled_box(
            f"Plinth_{key}",
            (w + 0.06, d + 0.06, plinth_h),
            (x, 0.0, plinth_h * 0.5),
            plinth_mat,
            bevel_width=0.015,
        )

        # Main slate column
        body_h = h - cap_thick - plinth_h
        add_beveled_box(
            f"Column_{key}",
            (w, d, body_h),
            (x, 0.0, plinth_h + body_h * 0.5),
            body_mat,
            bevel_width=0.03,
        )

        # Metallic top cap (Gold / Silver / Bronze)
        trim_mat = make_bsdf_material(
            f"Trim_{key}", spec["trim_color"], metallic=0.82, roughness=0.24
        )
        add_beveled_box(
            f"Cap_{key}",
            (w + 0.05, d + 0.05, cap_thick),
            (x, 0.0, h - cap_thick * 0.5),
            trim_mat,
            bevel_width=0.02,
        )

    # Transparent shadow-catcher floor under the podium
    bpy.ops.mesh.primitive_plane_add(size=16.0, location=(0.0, 0.0, 0.0))
    floor = bpy.context.active_object
    floor.name = "ShadowCatcherFloor"
    floor.is_shadow_catcher = True

    cam_obj = add_camera("PodiumCamera", loc=(0.0, -11.6, 2.55), target=(0.0, 0.0, 1.58), lens=64.0)
    bpy.context.view_layer.update()

    # Compute exact projected layout coordinates for the 2D Node compositor
    slots_layout = {}
    for key, spec in PEDESTALS.items():
        x = spec["x"]
        w = spec["width"]
        d = spec["depth"]
        h = spec["height"]

        # Where the kart's tires (Z=0) should rest on top of the pedestal
        top_x, top_y = project_to_pixel(scene, cam_obj, (x, 0.0, h), CANVAS_W, CANVAS_H)

        # Front plaque rectangle (inset slightly from edges, below cap, above plinth)
        front_y = -d * 0.5
        margin_x = 0.08
        top_z = h - cap_thick - 0.05
        bot_z = plinth_h + 0.05

        tl_x, tl_y = project_to_pixel(scene, cam_obj, (x - w * 0.5 + margin_x, front_y, top_z), CANVAS_W, CANVAS_H)
        tr_x, tr_y = project_to_pixel(scene, cam_obj, (x + w * 0.5 - margin_x, front_y, top_z), CANVAS_W, CANVAS_H)
        bl_x, bl_y = project_to_pixel(scene, cam_obj, (x - w * 0.5 + margin_x, front_y, bot_z), CANVAS_W, CANVAS_H)
        br_x, br_y = project_to_pixel(scene, cam_obj, (x + w * 0.5 - margin_x, front_y, bot_z), CANVAS_W, CANVAS_H)

        plaque_x = round(max(tl_x, bl_x))
        plaque_y = round(max(tl_y, tr_y))
        plaque_r = round(min(tr_x, br_x))
        plaque_b = round(min(bl_y, br_y))

        kw, kh = spec["kart_size"]
        slots_layout[key] = {
            "rank": spec["rank"],
            "kart_anchor": {"x": round(top_x), "y": round(top_y)},
            "kart_sprite_size": {"width": kw, "height": kh},
            "plaque": {
                "x": plaque_x,
                "y": plaque_y,
                "width": max(1, plaque_r - plaque_x),
                "height": max(1, plaque_b - plaque_y),
            },
        }

    podium_path = os.path.join(out_dir, "podium.png")
    scene.render.filepath = podium_path
    bpy.ops.render.render(write_still=True)
    return slots_layout


def compute_combined_bbox(objects):
    min_v = Vector((float("inf"), float("inf"), float("inf")))
    max_v = Vector((float("-inf"), float("-inf"), float("-inf")))
    for obj in objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            min_v.x = min(min_v.x, w.x)
            min_v.y = min(min_v.y, w.y)
            min_v.z = min(min_v.z, w.z)
            max_v.x = max(max_v.x, w.x)
            max_v.y = max(max_v.y, w.y)
            max_v.z = max(max_v.z, w.z)
    return min_v, max_v


def render_kart_poses(kart_id, kart_dir, shared_tex_dirs, out_karts_dir, samples):
    """Render 1st, 2nd, and 3rd place angles for a single kart; returns ground_y per slot."""
    scene = reset_scene(samples)
    add_studio_lights()

    objects = load_kart_into_blender(kart_dir, shared_texture_dirs=shared_tex_dirs)
    if not objects:
        print(f"[warn] No mesh objects imported for kart '{kart_id}', skipping.")
        return None

    # Parent all kart parts under a root Empty for clean centering, grounding, scaling, and rotation
    root = bpy.data.objects.new(f"{kart_id}_root", None)
    bpy.context.collection.objects.link(root)
    for obj in objects:
        obj.parent = root

    bpy.context.view_layer.update()
    min_v, max_v = compute_combined_bbox(objects)
    size = max_v - min_v
    center_xy = Vector(((min_v.x + max_v.x) * 0.5, (min_v.y + max_v.y) * 0.5, 0.0))

    # Shift children so kart is centered in X/Y and tires sit on Z = 0
    for obj in objects:
        obj.location.x -= center_xy.x
        obj.location.y -= center_xy.y
        obj.location.z -= min_v.z

    # Normalize visual size so every kart sits naturally on its pedestal without overlapping neighbors
    ref_dim = max(size.x, size.y * 0.85, size.z * 1.15, 0.1)

    # Transparent shadow catcher under the tires
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 0.0, 0.0))
    shadow_plane = bpy.context.active_object
    shadow_plane.name = "KartShadowCatcher"
    shadow_plane.is_shadow_catcher = True

    ground_y_by_slot = {}
    for key, spec in PEDESTALS.items():
        kw, kh = spec["kart_size"]
        scene.render.resolution_x = kw
        scene.render.resolution_y = kh
        scene.render.resolution_percentage = 100

        scale_factor = spec["kart_scale_target"] / ref_dim
        root.scale = (scale_factor, scale_factor, scale_factor)
        # STK karts face +Y in Blender after coord conversion; +180 deg faces camera at -Y
        root.rotation_euler = (0.0, 0.0, math.radians(180.0 + spec["kart_yaw_deg"]))

        cam_dist = spec["kart_cam_dist"]
        cam_obj = add_camera(
            f"KartCam_{key}",
            loc=(0.0, -cam_dist, cam_dist * 0.30),
            target=(0.0, 0.0, 0.52),
            lens=64.0,
        )
        bpy.context.view_layer.update()

        _, gy = project_to_pixel(scene, cam_obj, (0.0, 0.0, 0.0), kw, kh)
        ground_y_by_slot[key] = round(gy)

        out_path = os.path.join(out_karts_dir, f"{kart_id}_{key}.png")
        scene.render.filepath = out_path
        bpy.ops.render.render(write_still=True)

        bpy.data.objects.remove(cam_obj, do_unlink=True)

    return ground_y_by_slot


def discover_karts(stk_assets_dir, requested_karts):
    karts_root = os.path.join(stk_assets_dir, "karts")
    if not os.path.isdir(karts_root):
        raise FileNotFoundError(f"karts directory not found: {karts_root}")

    available = sorted(
        d
        for d in os.listdir(karts_root)
        if os.path.isfile(os.path.join(karts_root, d, "kart.xml"))
    )
    if requested_karts:
        wanted = [k.strip() for k in requested_karts.split(",") if k.strip()]
        missing = [k for k in wanted if k not in available]
        if missing:
            print(f"[warn] Requested karts not found in {karts_root}: {missing}")
        return [k for k in wanted if k in available]
    return available


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    out_karts_dir = os.path.join(args.out_dir, "karts")
    os.makedirs(out_karts_dir, exist_ok=True)

    layout_path = os.path.join(args.out_dir, "layout.json")
    layout = {
        "canvas": {"width": CANVAS_W, "height": CANVAS_H},
        "slots": {},
        "karts": [],
    }
    if os.path.isfile(layout_path):
        try:
            with open(layout_path, "r", encoding="utf-8") as fh:
                layout = json.load(fh)
        except Exception:
            pass

    if not args.skip_podium:
        print("==> Rendering 3D podium backdrop...")
        layout["slots"] = render_podium(args.out_dir, args.samples)

    if not args.only_podium:
        shared_tex_dirs = [
            os.path.join(args.stk_assets, "textures"),
        ]
        if args.stk_data:
            shared_tex_dirs.append(os.path.join(args.stk_data, "textures"))

        kart_ids = discover_karts(args.stk_assets, args.karts)
        print(f"==> Rendering {len(kart_ids)} karts (3 poses each, samples={args.samples})...")
        rendered = []
        ground_y_sample = None
        for idx, kart_id in enumerate(kart_ids, start=1):
            print(f"  [{idx}/{len(kart_ids)}] {kart_id}")
            kart_dir = os.path.join(args.stk_assets, "karts", kart_id)
            gy = render_kart_poses(kart_id, kart_dir, shared_tex_dirs, out_karts_dir, args.samples)
            if gy is not None:
                rendered.append(kart_id)
                ground_y_sample = gy

        if ground_y_sample and layout.get("slots"):
            for slot_key, gy in ground_y_sample.items():
                if slot_key in layout["slots"]:
                    layout["slots"][slot_key]["kart_ground_y"] = gy

        existing = set(layout.get("karts", []))
        layout["karts"] = sorted(existing | set(rendered))

    with open(layout_path, "w", encoding="utf-8") as fh:
        json.dump(layout, fh, indent=2)
    print(f"==> Done! Assets written to {args.out_dir}")


if __name__ == "__main__":
    main()
