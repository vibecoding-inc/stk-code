"""
Pure-Python SuperTuxKart .spm (v1) binary mesh parser and Blender importer.

Format reference: src/graphics/sp_mesh_loader.cpp in stk-code.
Supports both SPMN (static) and SPMA (skinned, bind pose) meshes, vertex colors,
packed 10-10-10-2 normals, half-float UVs, kart.xml wheel/headlight assembly,
and materials.xml transparency hints.
"""

import os
import struct
import xml.etree.ElementTree as ET


def _sign_extend_10(val):
    if val & 0x200:
        return val - 0x400
    return val


def unpack_normal_10_10_10_2(packed):
    """Unpack STK's 10-10-10-2 signed integer normal into (x, y, z) floats."""
    x = _sign_extend_10(packed & 0x3FF) / 511.0
    y = _sign_extend_10((packed >> 10) & 0x3FF) / 511.0
    z = _sign_extend_10((packed >> 20) & 0x3FF) / 511.0
    length = (x * x + y * y + z * z) ** 0.5
    if length > 1e-6:
        return (x / length, y / length, z / length)
    return (0.0, 1.0, 0.0)


def parse_spm_bytes(data):
    """
    Parse a SuperTuxKart .spm v1 binary buffer into a plain Python dict.

    Returns:
      {
        "header": "SPMA" | "SPMN",
        "bbox": (min_x, min_y, min_z, max_x, max_y, max_z),
        "materials": [{"tex1": str, "tex2": str}, ...],
        "buffers": [
          {
            "mat_id": int,
            "positions": [(x, y, z), ...],       # Irrlicht coords (Y-up, LH)
            "normals": [(nx, ny, nz), ...],
            "colors": [(r, g, b, a), ...],        # 0..1 floats
            "uv1": [(u, v), ...] | None,
            "indices": [int, ...],
          },
          ...
        ],
      }
    """
    offset = 0
    total_len = len(data)

    def read_fmt(fmt):
        nonlocal offset
        size = struct.calcsize(fmt)
        if offset + size > total_len:
            raise ValueError(f"Unexpected EOF at offset {offset} (need {size} bytes)")
        vals = struct.unpack_from(fmt, data, offset)
        offset += size
        return vals

    def read_bytes(n):
        nonlocal offset
        if offset + n > total_len:
            raise ValueError(f"Unexpected EOF at offset {offset} (need {n} bytes)")
        out = data[offset : offset + n]
        offset += n
        return out

    magic = read_bytes(2)
    if magic != b"SP":
        raise ValueError(f"Not an SPM file (magic={magic!r})")

    (ver_type,) = read_fmt("<B")
    version = ver_type >> 3
    if version != 1:
        raise ValueError(f"Unsupported SPM version: {version}")

    mesh_type = ver_type & ~0x08
    if mesh_type == 0:
        raise ValueError("SPMS (space partitioned mesh) is not supported")
    header = "SPMA" if mesh_type == 1 else "SPMN"
    is_skinned = header == "SPMA"

    (flags,) = read_fmt("<B")
    read_normal = bool(flags & 0x01)
    read_vcolor = bool((flags >> 1) & 0x01)
    read_tangent = bool((flags >> 2) & 0x01)

    bbox = read_fmt("<6f")

    (mat_count,) = read_fmt("<H")
    materials = []
    for _ in range(mat_count):
        (len1,) = read_fmt("<B")
        tex1 = read_bytes(len1).decode("utf-8", errors="replace") if len1 > 0 else ""
        (len2,) = read_fmt("<B")
        tex2 = read_bytes(len2).decode("utf-8", errors="replace") if len2 > 0 else ""
        materials.append({"tex1": tex1, "tex2": tex2})

    (sector_count,) = read_fmt("<H")
    buffers = []
    for _ in range(sector_count):
        (mat_size,) = read_fmt("<H")
        for _ in range(mat_size):
            vertices_count, indices_count, mat_id = read_fmt("<IIH")
            if mat_id >= len(materials):
                raise ValueError(f"Invalid material id {mat_id} (count={len(materials)})")
            uv_one = bool(materials[mat_id]["tex1"])
            uv_two = bool(materials[mat_id]["tex2"])

            positions = []
            normals = []
            colors = []
            uv1 = [] if uv_one else None

            for _ in range(vertices_count):
                positions.append(read_fmt("<3f"))
                if read_normal:
                    (packed_n,) = read_fmt("<I")
                    normals.append(unpack_normal_10_10_10_2(packed_n))
                else:
                    normals.append((0.0, 1.0, 0.0))

                if read_vcolor:
                    (ci,) = read_fmt("<B")
                    if ci == 128:
                        colors.append((1.0, 1.0, 1.0, 1.0))
                    else:
                        r, g, b = read_fmt("<3B")
                        colors.append((r / 255.0, g / 255.0, b / 255.0, 1.0))
                else:
                    colors.append((1.0, 1.0, 1.0, 1.0))

                if uv_one:
                    u, v = read_fmt("<2e")
                    uv1.append((u, v))
                    if uv_two:
                        read_fmt("<2e")
                    if read_tangent:
                        read_fmt("<I")

                if is_skinned:
                    # 4 * int16 joint indices + 4 * float16 weights = 16 bytes
                    read_bytes(16)

            if vertices_count > 255:
                indices = list(read_fmt(f"<{indices_count}H"))
            else:
                indices = list(read_fmt(f"<{indices_count}B"))

            buffers.append(
                {
                    "mat_id": mat_id,
                    "positions": positions,
                    "normals": normals,
                    "colors": colors,
                    "uv1": uv1,
                    "indices": indices,
                }
            )

    return {
        "header": header,
        "bbox": bbox,
        "materials": materials,
        "buffers": buffers,
    }


def parse_spm_file(path):
    with open(path, "rb") as fh:
        return parse_spm_bytes(fh.read())


def parse_vec3_attr(text, default=(0.0, 0.0, 0.0)):
    if not text:
        return default
    parts = text.replace(",", " ").split()
    if len(parts) < 3:
        return default
    return (float(parts[0]), float(parts[1]), float(parts[2]))


def irrlicht_to_blender_pos(pos):
    """Convert Irrlicht (X right, Y up, Z forward) to Blender (X right, Y forward, Z up)."""
    return (pos[0], pos[2], pos[1])


def parse_materials_xml(kart_dir):
    """Read optional materials.xml in kart_dir -> {lowercase_tex_name: {shader, gloss_map, ...}}."""
    mat_xml = os.path.join(kart_dir, "materials.xml")
    info = {}
    if not os.path.isfile(mat_xml):
        return info
    try:
        tree = ET.parse(mat_xml)
        root = tree.getroot()
    except ET.ParseError:
        return info
    for elem in root.findall("material"):
        name = (elem.attrib.get("name") or "").strip().lower()
        if not name:
            continue
        info[name] = {
            "shader": (elem.attrib.get("shader") or "solid").strip().lower(),
            "gloss_map": (elem.attrib.get("gloss-map") or "").strip(),
            "normal_map": (elem.attrib.get("normal-map") or "").strip(),
            "backface_culling": elem.attrib.get("backface-culling", "Y").upper() != "N",
        }
    return info


def resolve_texture_path(tex_name, search_dirs):
    """Resolve an SPM texture filename across kart_dir and shared texture directories."""
    if not tex_name:
        return None
    basename = os.path.basename(tex_name)
    stem, ext = os.path.splitext(basename)
    candidates = [tex_name, basename]
    for alt_ext in (".png", ".jpg", ".jpeg"):
        if alt_ext != ext.lower():
            candidates.append(stem + alt_ext)

    for directory in search_dirs:
        if not directory or not os.path.isdir(directory):
            continue
        for cand in candidates:
            full = os.path.join(directory, cand)
            if os.path.isfile(full):
                return full
        # Case-insensitive fallback within directory
        lower_targets = {os.path.basename(c).lower() for c in candidates}
        for entry in os.listdir(directory):
            if entry.lower() in lower_targets:
                full = os.path.join(directory, entry)
                if os.path.isfile(full):
                    return full
    return None


def _build_blender_material(name, tex_path, mat_meta, use_vcolor):
    import bpy

    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)

    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (100, 0)
    bsdf.inputs["Roughness"].default_value = 0.42
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.45
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.45
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    shader_type = (mat_meta or {}).get("shader", "solid")
    wants_alpha = shader_type in ("alphatest", "alphablend", "additive", "unlit")

    color_source = None
    if tex_path and os.path.isfile(tex_path):
        img = bpy.data.images.load(tex_path, check_existing=True)
        tex_node = nt.nodes.new("ShaderNodeTexImage")
        tex_node.image = img
        tex_node.location = (-400, 100)
        color_source = tex_node.outputs["Color"]

        if wants_alpha:
            nt.links.new(tex_node.outputs["Alpha"], bsdf.inputs["Alpha"])

    if use_vcolor:
        vcol = nt.nodes.new("ShaderNodeVertexColor")
        vcol.layer_name = "Col"
        vcol.location = (-400, -180)
        if color_source is not None:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            mix.location = (-120, 60)
            nt.links.new(color_source, mix.inputs["A"])
            nt.links.new(vcol.outputs["Color"], mix.inputs["B"])
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        else:
            nt.links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])
    elif color_source is not None:
        nt.links.new(color_source, bsdf.inputs["Base Color"])

    return mat


def import_spm_to_blender(spm_path, name_prefix, search_dirs, mat_xml_info=None, location=(0.0, 0.0, 0.0)):
    """Import a single .spm file into the active Blender scene and return created Objects."""
    import bpy

    parsed = parse_spm_file(spm_path)
    mat_xml_info = mat_xml_info or {}
    created = []

    for buf_idx, buf in enumerate(parsed["buffers"]):
        positions = [irrlicht_to_blender_pos(p) for p in buf["positions"]]
        raw_indices = buf["indices"]
        # Flip winding because converting LH (x,y,z) -> RH (x,z,y) mirrors handedness.
        faces = []
        for i in range(0, len(raw_indices) - 2, 3):
            a, b, c = raw_indices[i], raw_indices[i + 1], raw_indices[i + 2]
            if a != b and b != c and a != c:
                faces.append((a, c, b))

        if not positions or not faces:
            continue

        mesh_name = f"{name_prefix}_buf{buf_idx}"
        mesh = bpy.data.meshes.new(mesh_name)
        mesh.from_pydata(positions, [], faces)

        # Assign UVs (flip V for Blender's bottom-left UV origin)
        if buf["uv1"] is not None:
            uv_layer = mesh.uv_layers.new(name="UVMap")
            uvs = buf["uv1"]
            for poly in mesh.polygons:
                for loop_idx in poly.loop_indices:
                    vert_idx = mesh.loops[loop_idx].vertex_index
                    u, v = uvs[vert_idx]
                    uv_layer.data[loop_idx].uv = (u, 1.0 - v)

        # Assign vertex colors if any vertex is non-white
        colors = buf["colors"]
        has_non_white = any(
            c[0] < 0.995 or c[1] < 0.995 or c[2] < 0.995 for c in colors
        )
        if has_non_white:
            color_attr = mesh.color_attributes.new(
                name="Col", type="BYTE_COLOR", domain="CORNER"
            )
            for poly in mesh.polygons:
                for loop_idx in poly.loop_indices:
                    vert_idx = mesh.loops[loop_idx].vertex_index
                    color_attr.data[loop_idx].color = colors[vert_idx]

        # Smooth shading for clean kart silhouettes
        mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
        mesh.update()

        mat_def = parsed["materials"][buf["mat_id"]]
        tex1 = mat_def["tex1"]
        tex_path = resolve_texture_path(tex1, search_dirs)
        mat_meta = mat_xml_info.get(os.path.basename(tex1).lower())
        mat = _build_blender_material(
            f"{mesh_name}_mat", tex_path, mat_meta, has_non_white
        )
        mesh.materials.append(mat)

        obj = bpy.data.objects.new(mesh_name, mesh)
        obj.location = location
        bpy.context.collection.objects.link(obj)
        created.append(obj)

    return created


def load_kart_into_blender(kart_dir, shared_texture_dirs=()):
    """
    Parse kart.xml in `kart_dir` and import the kart body, wheels, and static
    attachments into Blender. Returns list of created Blender mesh objects.
    """
    kart_xml = os.path.join(kart_dir, "kart.xml")
    if not os.path.isfile(kart_xml):
        raise FileNotFoundError(f"Missing kart.xml in {kart_dir}")

    tree = ET.parse(kart_xml)
    root = tree.getroot()
    kart_id = os.path.basename(os.path.normpath(kart_dir))
    search_dirs = [kart_dir] + list(shared_texture_dirs)
    mat_xml_info = parse_materials_xml(kart_dir)

    objects = []

    model_file = root.attrib.get("model-file")
    if model_file:
        body_path = os.path.join(kart_dir, model_file)
        if os.path.isfile(body_path):
            objects.extend(
                import_spm_to_blender(
                    body_path, f"{kart_id}_body", search_dirs, mat_xml_info
                )
            )

    wheels_node = root.find("wheels")
    if wheels_node is not None:
        for wheel_tag in ("front-right", "front-left", "rear-right", "rear-left"):
            w = wheels_node.find(wheel_tag)
            if w is None:
                continue
            w_model = w.attrib.get("model")
            if not w_model:
                continue
            w_path = os.path.join(kart_dir, w_model)
            if not os.path.isfile(w_path):
                continue
            pos = irrlicht_to_blender_pos(parse_vec3_attr(w.attrib.get("position")))
            objects.extend(
                import_spm_to_blender(
                    w_path,
                    f"{kart_id}_{wheel_tag}",
                    search_dirs,
                    mat_xml_info,
                    location=pos,
                )
            )

    # Optional static attachments (headlights / exhausts) if present as .spm
    for group_tag in ("headlights", "speed-weighted-objects"):
        group_node = root.find(group_tag)
        if group_node is None:
            continue
        for idx, child in enumerate(group_node):
            c_model = child.attrib.get("model")
            if not c_model or not c_model.lower().endswith(".spm"):
                continue
            c_path = os.path.join(kart_dir, c_model)
            if not os.path.isfile(c_path):
                continue
            pos = irrlicht_to_blender_pos(parse_vec3_attr(child.attrib.get("position")))
            objects.extend(
                import_spm_to_blender(
                    c_path,
                    f"{kart_id}_{group_tag}_{idx}",
                    search_dirs,
                    mat_xml_info,
                    location=pos,
                )
            )

    return objects
