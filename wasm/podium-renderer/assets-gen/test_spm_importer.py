"""Unit tests for the pure-Python .spm v1 binary parser (no Blender required)."""

import struct
import unittest

from spm_importer import (
    irrlicht_to_blender_pos,
    parse_spm_bytes,
    parse_vec3_attr,
    unpack_normal_10_10_10_2,
)


def _build_synthetic_spm(*, skinned=False, read_normal=True, read_vcolor=True, read_tangent=True):
    out = bytearray()
    out += b"SP"
    # version=1 (1 << 3 = 8), type=1 (SPMA) or 2 (SPMN)
    ver_type = (1 << 3) | (1 if skinned else 2)
    flags = (1 if read_normal else 0) | ((1 if read_vcolor else 0) << 1) | ((1 if read_tangent else 0) << 2)
    out += struct.pack("<BB", ver_type, flags)
    # bbox (6 floats)
    out += struct.pack("<6f", -1.0, 0.0, -2.0, 1.0, 1.5, 2.0)
    # 1 material with tex1="kart.png", tex2=""
    out += struct.pack("<H", 1)
    tex1 = b"kart.png"
    out += struct.pack("<B", len(tex1)) + tex1
    out += struct.pack("<B", 0)
    # 1 sector, 1 mesh buffer
    out += struct.pack("<HH", 1, 1)
    # 3 vertices, 3 indices, mat_id=0
    out += struct.pack("<IIH", 3, 3, 0)

    verts = [
        ((0.0, 0.0, 0.0), (0.0, 0.0), (255, 255, 255), True),
        ((1.0, 0.5, 2.0), (0.5, 1.0), (200, 100, 50), False),
        ((-1.0, 0.5, 2.0), (1.0, 0.5), (255, 255, 255), True),
    ]
    for pos, uv, rgb, is_white in verts:
        out += struct.pack("<3f", *pos)
        if read_normal:
            # +Y normal: 511 << 10
            out += struct.pack("<I", 511 << 10)
        if read_vcolor:
            if is_white:
                out += struct.pack("<B", 128)
            else:
                out += struct.pack("<BBBB", 0, rgb[0], rgb[1], rgb[2])
        # uv1 (2 * float16)
        out += struct.pack("<2e", uv[0], uv[1])
        if read_tangent:
            out += struct.pack("<I", 0)
        if skinned:
            # 4 * int16 joints + 4 * float16 weights
            out += struct.pack("<4h4e", 0, -1, -1, -1, 1.0, 0.0, 0.0, 0.0)

    # 3 uint8 indices (since vertices_count <= 255)
    out += struct.pack("<3B", 0, 1, 2)
    return bytes(out)


class TestSpmImporter(unittest.TestCase):
    def test_parse_spmn_static(self):
        raw = _build_synthetic_spm(skinned=False)
        parsed = parse_spm_bytes(raw)
        self.assertEqual(parsed["header"], "SPMN")
        self.assertEqual(parsed["materials"], [{"tex1": "kart.png", "tex2": ""}])
        self.assertEqual(len(parsed["buffers"]), 1)
        buf = parsed["buffers"][0]
        self.assertEqual(len(buf["positions"]), 3)
        self.assertAlmostEqual(buf["positions"][1][2], 2.0)
        self.assertEqual(buf["indices"], [0, 1, 2])
        self.assertAlmostEqual(buf["colors"][0][0], 1.0)
        self.assertAlmostEqual(buf["colors"][1][0], 200 / 255.0, places=3)
        self.assertAlmostEqual(buf["uv1"][1][0], 0.5, places=3)
        self.assertAlmostEqual(buf["uv1"][1][1], 1.0, places=3)

    def test_parse_spma_skinned(self):
        raw = _build_synthetic_spm(skinned=True, read_tangent=False)
        parsed = parse_spm_bytes(raw)
        self.assertEqual(parsed["header"], "SPMA")
        self.assertEqual(parsed["buffers"][0]["indices"], [0, 1, 2])

    def test_normal_unpack(self):
        nx, ny, nz = unpack_normal_10_10_10_2(511 << 10)
        self.assertAlmostEqual(nx, 0.0, places=4)
        self.assertAlmostEqual(ny, 1.0, places=4)
        self.assertAlmostEqual(nz, 0.0, places=4)

    def test_coord_conversion(self):
        self.assertEqual(irrlicht_to_blender_pos((1.0, 2.0, 3.0)), (1.0, 3.0, 2.0))
        self.assertEqual(parse_vec3_attr("0.5 -0.2 1.25"), (0.5, -0.2, 1.25))


if __name__ == "__main__":
    unittest.main()
