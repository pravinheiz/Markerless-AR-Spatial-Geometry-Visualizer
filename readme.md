# 🖐️ Markerless AR Spatial Geometry Visualizer

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Three.js](https://img.shields.io/badge/Three.js-r160-blue.svg)](https://threejs.org/)
[![MediaPipe](https://img.shields.io/badge/MediaPipe-Hands-orange.svg)](https://developers.google.com/mediapipe)
[![Web-AR](https://img.shields.io/badge/Platform-Web--AR-brightgreen.svg)]()

A high-performance, browser-based **Markerless Augmented Reality (AR) Spatial Geometry Visualizer & 3D Curve Synthesis Engine**. Create, manipulate, paint, and mathematically analyze 3D spatial geometry in mid-air using real-time computer vision hand tracking through a standard webcam without requiring controllers, physical fiducial markers, or expensive AR headsets.

---

## 🌟 Key Capabilities & Features

- 🖐️ **Markerless 3D Hand Tracking**: Real-time 21-keypoint hand landmark tracking powered by client-side MediaPipe ML neural networks (60 FPS, sub-20ms latency).
- 🎨 **Volumetric 3D Spatial Curve Synthesis**: Synthesize continuous 3D volumetric neon ribbons and tubes in spatial depth using single-hand pinch gestures.
- ✊ **6-DOF Spatial Kinematic Manipulation**: Natural single-hand wrist-tilt orientation (Pitch, Yaw, Roll) and 3D translation.
- 🤏🤏 **Bimanual Dual-Pinch Zoom**: Spread or close pinched hands to dynamically scale active 3D geometry or zoom the scene camera.
- 📊 **Real-Time Spatial Geometry Analytics HUD**: Live computation of mathematical Volume ($V$), Surface Area ($A$), Centroid, Bounding Box ($W \times H \times D$), and vertex/edge counts.
- 📏 **AR 2-Hand Laser Ruler**: Measure physical 3D distance between your hands in real-time with sub-centimeter telemetry.
- 🌈 **Material Shaders & Color Palette**: Hologram Wireframe, Physical Glass, Metallic Chrome, and Neon Glow shaders with a 6-color brush palette.
- 🔊 **Pure Web Audio Synthesizer**: Clean synthesized audio feedback waveforms without external asset dependencies.
- 💻 **Desktop Mouse & Touch Fallback**: Interactive 3D manipulation mode with Three.js OrbitControls if webcam is unavailable.

---

## 🖐️ Hand Gesture Reference Guide

| Gesture | Icon | Action & Description |
| :--- | :---: | :--- |
| **Single Pinch** | 🤏 | Synthesize 3D volumetric ribbon (in `🎨 3D Paint` mode) or activate UI buttons. |
| **Fist / Grab** | ✊ | Grab active 3D hologram for 6-DOF translation and 3D wrist-tilt rotation. |
| **Dual-Hand Pinch** | 🤏🤏 | Bimanual Dual-Pinch Scale to dynamically scale the active geometry or zoom scene. |
| **2-Hand Vertical** | ↕️ | Extrude drawn 2D planar profiles into solid 3D tubes. |
| **2-Hand Spread** | 📏 | Measure real-time spatial distance between hands in meters. |
| **Open Palm Pointer** | 🖐️ | Optical index fingertip cursor for contactless hovering and selecting. |

---

## 🚀 Quick Start / Local Setup

No build steps or complex dependencies required. Simply serve the repository with any local static HTTP server:

### 1. Clone the repository
```bash
git clone https://github.com/pravinheiz/Markerless-AR-Spatial-Geometry-Visualizer.git
cd Markerless-AR-Spatial-Geometry-Visualizer
```

### 2. Start local server
Using Python:
```bash
python -m http.server 8080
```
Or using Node.js `npx`:
```bash
npx serve .
```

### 3. Open in Browser
- Open `http://localhost:8080` in any modern web browser.

---

## 🛠️ Technology Stack

- **Computer Vision**: [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) (WebAssembly + Neural Network)
- **3D Graphics Engine**: [Three.js r160](https://threejs.org/) (WebGL, PCFSoftShadowMap, Catmull-Rom Splines)
- **UI & Styling**: Vanilla HTML5, CSS3 Glassmorphism, Google Fonts (`Outfit`, `JetBrains Mono`)
- **Audio Engine**: Web Audio API (real-time synthesized waveforms)

---

## 📄 License

MIT License — Feel free to use and expand for academic, research, and open-source projects!

---

## 🌐 Complete Code Repository Location

The complete, open-source codebase for this project is hosted on GitHub:  
👉 **[https://github.com/pravinheiz/Markerless-AR-Spatial-Geometry-Visualizer](https://github.com/pravinheiz/Markerless-AR-Spatial-Geometry-Visualizer)**
