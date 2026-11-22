# Podium 3D Asset Generator (Blender)

Headless Dockerized Blender pipeline that pre-renders:
- `podium.png` (`1200×675` transparent 3D championship podium with Gold/Silver/Bronze metallic caps and grounded shadows)
- `karts/<kart_id>_{1,2,3}.png` (transparent 3D renders of each kart from 1st/2nd/3rd place camera angles with baked tire contact shadows)
- `layout.json` (exact camera-projected pixel coordinates for each pedestal's kart anchor and front plaque area)

## Usage

### 1. Render just the 3D podium (no `stk-assets` needed)
```bash
wasm/podium-renderer/assets-gen/generate.sh --only-podium --samples 48
```

### 2. Fast local test with a few karts
Ensure `wasm/stk-assets` is checked out (`wasm/get_assets.sh`), then run:
```bash
wasm/podium-renderer/assets-gen/generate.sh --karts tux,nolok,hexley --samples 32
```

### 3. Full render (all karts, used in CI)
```bash
wasm/podium-renderer/assets-gen/generate.sh --samples 48
```

Output is written to `wasm/podium-renderer/generated-assets/` (gitignored).

## Running Unit Tests

The pure-Python `.spm` binary parser can be tested without Blender:
```bash
python3 -m unittest discover -s wasm/podium-renderer/assets-gen -v
```
