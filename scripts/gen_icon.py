#!/usr/bin/env python3
"""Generate Nova app icon with AI aesthetic + 3D depth.

Design:
- Dark gradient background with depth
- 3D tubular gradient ring (cyan-blue to purple) with highlights & shadow
- Bright vertical line with cylindrical highlight
- macOS-style rounded square background
"""

import math
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

SIZE = 1024
CENTER = SIZE // 2


def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, int(v)))


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return (clamp(lerp(c1[0], c2[0], t)),
            clamp(lerp(c1[1], c2[1], t)),
            clamp(lerp(c1[2], c2[2], t)))


def draw_rounded_rect_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size-1, size-1], radius=radius, fill=255)
    return mask


def generate_icon():
    print("Generating Nova icon with 3D depth...")

    # === Step 1: Background ===
    print("  Creating background...")
    bg = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 255))
    
    # Radial gradient background with slight upper-left light source
    light_x, light_y = SIZE * 0.35, SIZE * 0.3  # Light comes from upper-left
    for y in range(SIZE):
        for x in range(SIZE):
            # Distance from center for base gradient
            dist_center = math.sqrt((x - CENTER)**2 + (y - CENTER)**2) / (SIZE * 0.7)
            dist_center = min(dist_center, 1.0)
            
            # Distance from light source for subtle highlight
            dist_light = math.sqrt((x - light_x)**2 + (y - light_y)**2) / SIZE
            
            # Base: dark blue-purple
            base_r = lerp(22, 8, dist_center)
            base_g = lerp(20, 6, dist_center)
            base_b = lerp(42, 18, dist_center)
            
            # Subtle light influence (upper left slightly brighter)
            light_influence = max(0, 1.0 - dist_light * 1.5) * 0.08
            base_r += light_influence * 40
            base_g += light_influence * 30
            base_b += light_influence * 60
            
            bg.putpixel((x, y), (clamp(base_r), clamp(base_g), clamp(base_b), 255))

    # Apply rounded rect mask
    print("  Applying rounded corners...")
    corner_radius = int(SIZE * 0.22)
    mask = draw_rounded_rect_mask(SIZE, corner_radius)
    
    final = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(bg, (0, 0), mask)

    # === Step 2: Inner shadow (depth inside the ring) ===
    print("  Adding inner depth...")
    inner_shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ring_outer_r = int(SIZE * 0.33)
    ring_inner_r = int(SIZE * 0.26)
    ring_mid_r = (ring_outer_r + ring_inner_r) / 2.0
    ring_thickness = ring_outer_r - ring_inner_r
    
    # Dark region inside the ring (recessed look)
    for y in range(CENTER - ring_inner_r, CENTER + ring_inner_r):
        for x in range(CENTER - ring_inner_r, CENTER + ring_inner_r):
            dist = math.sqrt((x - CENTER)**2 + (y - CENTER)**2)
            if dist < ring_inner_r:
                # Darker near the ring edge, lighter toward center
                edge_proximity = 1.0 - (ring_inner_r - dist) / ring_inner_r
                edge_proximity = edge_proximity ** 0.5  # More gradual
                darkness = edge_proximity * 0.3
                inner_shadow.putpixel((x, y), (0, 0, 0, clamp(darkness * 255)))
    
    inner_shadow = inner_shadow.filter(ImageFilter.GaussianBlur(radius=8))
    final = Image.alpha_composite(final, inner_shadow)

    # === Step 3: 3D Gradient Ring ===
    print("  Drawing 3D gradient ring...")
    ring_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    
    # Colors - brighter base colors for better visibility against dark bg
    color_cyan = (30, 225, 255)
    color_purple = (200, 130, 255)
    
    # Light direction (upper-left, normalized)
    light_angle = math.radians(-45)  # -45 degrees = upper-left
    
    for y in range(CENTER - ring_outer_r - 2, CENTER + ring_outer_r + 2):
        for x in range(CENTER - ring_outer_r - 2, CENTER + ring_outer_r + 2):
            if x < 0 or x >= SIZE or y < 0 or y >= SIZE:
                continue
            dist = math.sqrt((x - CENTER)**2 + (y - CENTER)**2)
            
            if ring_inner_r <= dist <= ring_outer_r:
                # === Angular gradient (color) ===
                angle = math.atan2(y - CENTER, x - CENTER)
                t = (angle + math.pi) / (2 * math.pi)
                t = (t + 0.25) % 1.0
                # Smooth loop using cosine
                blend = 0.5 * (1.0 - math.cos(t * 2 * math.pi))
                base_r, base_g, base_b = lerp_color(color_cyan, color_purple, blend)
                
                # === 3D tubular shading ===
                # Position within ring thickness: 0 = inner edge, 1 = outer edge
                ring_pos = (dist - ring_inner_r) / (ring_outer_r - ring_inner_r)
                
                # Map ring_pos to tube cross-section angle
                tube_angle = (ring_pos - 0.5) * math.pi
                
                # Normal of the tube surface
                point_angle = math.atan2(y - CENTER, x - CENTER)
                nx = math.cos(point_angle) * math.cos(tube_angle)
                ny = math.sin(point_angle) * math.cos(tube_angle)
                nz = math.sin(tube_angle)
                
                # Light vector (upper-left, slightly forward)
                lx = math.cos(light_angle) * 0.6
                ly = math.sin(light_angle) * 0.6
                lz = 0.75
                l_len = math.sqrt(lx*lx + ly*ly + lz*lz)
                lx, ly, lz = lx/l_len, ly/l_len, lz/l_len
                
                # Diffuse lighting
                diffuse = max(0, nx*lx + ny*ly + nz*lz)
                
                # Specular highlight (Blinn-Phong)
                hx = lx
                hy = ly
                hz = lz + 1.0
                h_len = math.sqrt(hx*hx + hy*hy + hz*hz)
                hx, hy, hz = hx/h_len, hy/h_len, hz/h_len
                spec = max(0, nx*hx + ny*hy + nz*hz) ** 20
                
                # Additive lighting model: base color stays full, only ADD highlights
                # This keeps the ring bright everywhere while adding 3D depth via highlights
                highlight_add = diffuse * 0.25 + spec * 0.7
                
                final_r = clamp(base_r + highlight_add * 200)
                final_g = clamp(base_g + highlight_add * 200)
                final_b = clamp(base_b + highlight_add * 200)
                
                # Subtle darkening only on extreme backface (very gentle)
                backface = max(0, -(nx*lx + ny*ly + nz*lz))
                darken = backface * 0.15  # Very subtle
                final_r = clamp(final_r * (1.0 - darken))
                final_g = clamp(final_g * (1.0 - darken))
                final_b = clamp(final_b * (1.0 - darken))
                
                # Anti-alias edges
                alpha = 255
                edge_width = 2.5
                if dist < ring_inner_r + edge_width:
                    alpha = clamp(255 * (dist - ring_inner_r) / edge_width)
                elif dist > ring_outer_r - edge_width:
                    alpha = clamp(255 * (ring_outer_r - dist) / edge_width)
                
                ring_layer.putpixel((x, y), (final_r, final_g, final_b, alpha))
    
    # Outer glow
    print("  Adding glow...")
    glow_layer = ring_layer.copy()
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=18))
    enhancer = ImageEnhance.Brightness(glow_layer)
    glow_layer = enhancer.enhance(1.2)
    final = Image.alpha_composite(final, glow_layer)
    
    # Ring shadow (below/right)
    shadow_layer = ring_layer.copy()
    shadow_img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    # Shift shadow down and right slightly
    shadow_img.paste(shadow_layer, (4, 6))
    # Make it dark
    shadow_data = shadow_img.load()
    for sy in range(SIZE):
        for sx in range(SIZE):
            r, g, b, a = shadow_data[sx, sy]
            if a > 0:
                shadow_data[sx, sy] = (0, 0, 0, clamp(a * 0.4))
    shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(radius=10))
    final = Image.alpha_composite(final, shadow_img)
    
    # Composite ring
    final = Image.alpha_composite(final, ring_layer)

    # === Step 4: 3D Vertical Line ===
    print("  Drawing 3D vertical line...")
    line_layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    
    line_length = int(SIZE * 0.22)
    line_width = int(SIZE * 0.045)
    half_len = line_length // 2
    half_w = line_width // 2
    
    # Draw line with cylindrical shading
    for y in range(CENTER - half_len - half_w, CENTER + half_len + half_w):
        for x in range(CENTER - half_w - 1, CENTER + half_w + 2):
            # Distance from line center axis
            dx = x - CENTER
            dy = y - CENTER
            
            # Check if within rounded rect bounds
            in_body = abs(dx) <= half_w and abs(dy) <= half_len
            in_top_cap = (dx**2 + (dy + half_len)**2) <= half_w**2
            in_bot_cap = (dx**2 + (dy - half_len)**2) <= half_w**2
            
            if in_body or in_top_cap or in_bot_cap:
                # Cylindrical shading: highlight in center, darker at edges
                cross_pos = (dx + half_w) / (2 * half_w)  # 0..1 across width
                
                # Tube normal
                tube_angle = (cross_pos - 0.5) * math.pi
                nx = math.sin(tube_angle)
                nz = math.cos(tube_angle)
                
                # Light from upper-left
                lx_l = math.cos(light_angle) * 0.4
                lz_l = 0.9
                l_len = math.sqrt(lx_l**2 + lz_l**2)
                lx_l, lz_l = lx_l/l_len, lz_l/l_len
                
                diffuse = max(0, nx * lx_l + nz * lz_l)
                
                # Specular
                hx = lx_l
                hz = lz_l + 1.0
                h_len = math.sqrt(hx**2 + hz**2)
                hx, hz = hx/h_len, hz/h_len
                spec = max(0, nx*hx + nz*hz) ** 16
                
                brightness = 0.5 + diffuse * 0.4 + spec * 0.8
                
                r = clamp(220 * brightness + spec * 200)
                g = clamp(235 * brightness + spec * 200)
                b = clamp(255 * brightness + spec * 200)
                
                # Soft edge anti-alias
                edge_dist = half_w - abs(dx)
                alpha = clamp(edge_dist * 128) if edge_dist < 2 else 255
                
                line_layer.putpixel((x, y), (r, g, b, alpha))
    
    # Line glow
    line_glow = line_layer.copy()
    line_glow = line_glow.filter(ImageFilter.GaussianBlur(radius=10))
    final = Image.alpha_composite(final, line_glow)
    
    line_glow2 = line_layer.copy()
    line_glow2 = line_glow2.filter(ImageFilter.GaussianBlur(radius=4))
    final = Image.alpha_composite(final, line_glow2)
    
    final = Image.alpha_composite(final, line_layer)

    # === Step 5: Subtle top highlight on background (glass effect) ===
    print("  Adding glass highlight...")
    highlight = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    for y in range(SIZE // 3):
        t = 1.0 - (y / (SIZE / 3))
        t = t ** 2  # Quadratic falloff
        alpha = int(t * 18)
        for x in range(SIZE):
            highlight.putpixel((x, y), (255, 255, 255, alpha))
    
    # Mask highlight to rounded rect
    highlight_masked = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    highlight_masked.paste(highlight, (0, 0), mask)
    final = Image.alpha_composite(final, highlight_masked)

    # === Save ===
    output_path = "/Users/wangxf/workspace/nova/src-tauri/icons/icon.png"
    final.save(output_path, 'PNG')
    print(f"  Saved: {output_path}")
    
    public_path = "/Users/wangxf/workspace/nova/public/icon.png"
    final.save(public_path, 'PNG')
    print(f"  Saved: {public_path}")
    
    return final


if __name__ == "__main__":
    generate_icon()
    print("Done!")
