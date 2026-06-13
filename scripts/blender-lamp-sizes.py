# Физически корректная мягкая полутень в Cycles: задать РАЗМЕР всех ламп.
# Запускать внутри Blender (напр. через MCP). Cycles: мягкость тени = размер
# источника (в Eevee — отдельные Contact Shadows / Cube Size, у нас Cycles, не нужны).
import bpy

POINT_SPOT_RADIUS = 0.12  # м (Point/Spot shadow_soft_size 0.1–0.15)
AREA_SIZE = 0.6           # м (Area size 0.5–1.0)

changed = {"POINT": 0, "SPOT": 0, "AREA": 0}
for o in bpy.data.objects:
    if o.type != "LIGHT":
        continue
    L = o.data
    if L.type in ("POINT", "SPOT"):
        L.shadow_soft_size = POINT_SPOT_RADIUS
        changed[L.type] += 1
    elif L.type == "AREA":
        L.size = AREA_SIZE
        if getattr(L, "shape", "SQUARE") in ("RECTANGLE", "ELLIPSE"):
            L.size_y = AREA_SIZE
        changed["AREA"] += 1
print("lamp sizes set:", changed)
