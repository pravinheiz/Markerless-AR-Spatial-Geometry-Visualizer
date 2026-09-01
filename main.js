import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/**
 * CONFIGURATION & CONSTANTS
 */
const CFG = {
    SMOOTHING: 0.35,
    PINCH_ENTER: 0.048,
    PINCH_EXIT: 0.068,
    GRAB_DIST: 0.28,
    ROT_SENS: 0.06,
    COLORS: {
        PRIMARY: 0x00ff88,
        ACCENT: 0x00ccff,
        WARN: 0xffaa00,
        DANGER: 0xff3366,
        GLASS: 0x1a2636
    }
};

/**
 * STATE MANAGEMENT
 */
const STATE = {
    mode: 'IDLE', // IDLE, DRAWING, GRABBED, EXTRUDING, MEASURING
    gesture: 'NONE',
    selectedShape: 'DRAW', // DRAW, CUBE, SPHERE, CYLINDER, CONE, TORUS, PYRAMID
    selectedMaterial: 'HOLOGRAM', // HOLOGRAM, GLASS, METAL, NEON
    hands: [],
    landmarks: [], // Smoothed 3D landmarks
    objects: [],
    selectedObj: null,
    currentLine: null,
    linePoints: [],
    showSkeleton: true,
    enableSFX: true,
    isPinching: false,
    cameraDepth: 3.5
};

// DOM ELEMENTS
const video = document.getElementById('webcam-input');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const webglCanvas = document.getElementById('webgl-canvas');
const uiGesture = document.getElementById('gesture-display');
const uiMode = document.getElementById('mode-display');
const uiTrack = document.getElementById('track-bar');
const uiTrackVal = document.getElementById('track-val');
const uiFps = document.getElementById('fps-val');
const crosshair = document.getElementById('crosshair');
const prompt = document.getElementById('prompt');
const loading = document.getElementById('loading');
const rulerDisplay = document.getElementById('ruler-display');
const rulerVal = document.getElementById('ruler-val');

// METRICS METERS
const mName = document.getElementById('m-name');
const mVol = document.getElementById('m-vol');
const mArea = document.getElementById('m-area');
const mBounds = document.getElementById('m-bounds');
const mVerts = document.getElementById('m-verts');

// THREE.JS GLOBALS
let scene, camera, renderer, raycaster, spatialPlane, laserLine;
let clock = new THREE.Clock();
let audioCtx = null;

/**
 * SECTION 1: AUDIO SYNTHESIZER (WEB AUDIO API)
 */
function initAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioCtx = new AudioContext();
    }
}

function playSound(type) {
    if (!STATE.enableSFX || !audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

    if (type === 'pinch') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
    } else if (type === 'spawn') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.18);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
    } else if (type === 'extrude') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.linearRampToValueAtTime(520, now + 0.25);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
    } else if (type === 'grab') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + 0.15);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
    } else if (type === 'clear') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.25);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
    }
}

/**
 * SECTION 2: MEDIAPIPE HAND TRACKING & SMOOTHING
 */
const prevLandmarks = [];

function smoothLandmark(current, prev, alpha) {
    if (!prev) return { ...current };
    return {
        x: current.x * alpha + prev.x * (1 - alpha),
        y: current.y * alpha + prev.y * (1 - alpha),
        z: (current.z || 0) * alpha + (prev.z || 0) * (1 - alpha)
    };
}

function getDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = (p1.z || 0) - (p2.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function initMediaPipe() {
    const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.65
    });

    hands.onResults(onHandsResults);

    const cam = new Camera(video, {
        onFrame: async () => await hands.send({ image: video }),
        width: 1280,
        height: 720
    });

    cam.start()
        .then(() => {
            loading.style.opacity = '0';
            setTimeout(() => loading.style.display = 'none', 500);
        })
        .catch(err => {
            console.warn("Camera access failed or unavailable. Falling back to Mouse mode.", err);
            loading.style.opacity = '0';
            setTimeout(() => loading.style.display = 'none', 500);
            enableMouseFallback();
        });
}

function onHandsResults(results) {
    // Resize 2D hand skeleton canvas to match window
    if (handCanvas.width !== window.innerWidth || handCanvas.height !== window.innerHeight) {
        handCanvas.width = window.innerWidth;
        handCanvas.height = window.innerHeight;
    }
    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);

    STATE.hands = results.multiHandLandmarks || [];
    STATE.landmarks = [];
    let totalConf = 0;

    if (STATE.hands.length === 0) {
        STATE.gesture = 'NONE';
        if (STATE.mode === 'DRAWING') finalizeDrawing();
        if (STATE.mode === 'GRABBED') unselectObject();
        if (laserLine) laserLine.visible = false;
        rulerDisplay.classList.add('hidden');
        STATE.mode = 'IDLE';
        updateUI(0);
        return;
    }

    // PHASE 1: Collect & Smooth Landmarks for all detected hands
    STATE.hands.forEach((lmList, idx) => {
        if (!prevLandmarks[idx]) prevLandmarks[idx] = [];
        const smoothed = lmList.map((lm, i) => {
            prevLandmarks[idx][i] = smoothLandmark(lm, prevLandmarks[idx][i], CFG.SMOOTHING);
            return prevLandmarks[idx][i];
        });
        STATE.landmarks.push(smoothed);
        totalConf += 0.9; // Base confidence estimation

        if (STATE.showSkeleton) drawSkeleton(smoothed, idx);
    });

    // PHASE 2: Single-Hand Gesture Analysis (Primary Hand = Index 0)
    const primaryLm = STATE.landmarks[0];
    const thumb = primaryLm[4];
    const index = primaryLm[8];
    const middle = primaryLm[12];
    const ring = primaryLm[16];
    const pinky = primaryLm[20];
    const wrist = primaryLm[0];

    const pinchDist = getDistance(thumb, index);
    const handScale = getDistance(wrist, primaryLm[9]) || 0.2; // Wrist to MCP middle
    const isGrabbed = (
        getDistance(index, wrist) / handScale < 1.3 &&
        getDistance(middle, wrist) / handScale < 1.3 &&
        getDistance(ring, wrist) / handScale < 1.3 &&
        getDistance(pinky, wrist) / handScale < 1.3
    );

    // Hysteresis threshold check for Pinch
    if (!STATE.isPinching && pinchDist < CFG.PINCH_ENTER) {
        STATE.isPinching = true;
        playSound('pinch');
    } else if (STATE.isPinching && pinchDist > CFG.PINCH_EXIT) {
        STATE.isPinching = false;
    }

    // PHASE 3: Multi-Hand Spatial Measurement Check
    let isTwoHand = false;
    if (STATE.landmarks.length === 2) {
        const h1 = STATE.landmarks[0][8]; // Index tip hand 1
        const h2 = STATE.landmarks[1][8]; // Index tip hand 2
        
        if (h1 && h2) {
            const pt1 = getSpatialPoint(h1);
            const pt2 = getSpatialPoint(h2);
            
            if (pt1 && pt2) {
                isTwoHand = true;
                const distMeters = pt1.distanceTo(pt2);
                
                // Update AR Ruler Overlay
                rulerDisplay.classList.remove('hidden');
                rulerVal.innerText = `${distMeters.toFixed(2)} m`;
                
                // Render 3D Laser Measurement Line
                updateLaserLine(pt1, pt2);

                // Two Hand Vertical Extrude Trigger
                const vertDiff = Math.abs(h1.y - h2.y);
                if (vertDiff > 0.25 && STATE.gesture === 'PINCH') {
                    STATE.mode = 'EXTRUDING';
                    extrudeLastLine();
                } else {
                    STATE.gesture = 'TWO_HAND';
                    STATE.mode = 'MEASURING';
                }
            }
        }
    } else {
        if (laserLine) laserLine.visible = false;
        rulerDisplay.classList.add('hidden');
    }

    // PHASE 4: Primary Gesture State Machine Logic
    if (!isTwoHand) {
        if (STATE.isPinching) {
            STATE.gesture = 'PINCH';
            if (STATE.selectedShape === 'DRAW') {
                if (STATE.mode !== 'DRAWING') {
                    STATE.mode = 'DRAWING';
                }
            } else {
                // Instantly spawn shape primitive at pinch location
                spawnShapePrimitive(STATE.selectedShape, index);
                STATE.isPinching = false; // Reset to prevent continuous spawning
            }
        } else if (isGrabbed) {
            STATE.gesture = 'GRAB';
            if (STATE.mode !== 'GRABBED') {
                selectNearestObject(index);
                if (STATE.selectedObj) {
                    STATE.mode = 'GRABBED';
                    playSound('grab');
                }
            }
        } else {
            STATE.gesture = 'OPEN';
            if (STATE.mode === 'DRAWING') finalizeDrawing();
            if (STATE.mode === 'GRABBED') unselectObject();
            STATE.mode = 'IDLE';
        }
    }

    updateUI(totalConf / (STATE.hands.length || 1));
}

function drawSkeleton(lm, handIdx) {
    const color = handIdx === 0 ? '#00ff88' : '#00ccff';
    handCtx.strokeStyle = color;
    handCtx.lineWidth = 2.5;
    handCtx.beginPath();

    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
        [0, 5], [5, 6], [6, 7], [7, 8], // Index
        [0, 9], [9, 10], [10, 11], [11, 12], // Middle
        [0, 13], [13, 14], [14, 15], [15, 16], // Ring
        [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
        [5, 9], [9, 13], [13, 17] // Palm Cross
    ];

    connections.forEach(([i, j]) => {
        const p1 = lm[i];
        const p2 = lm[j];
        handCtx.moveTo(p1.x * handCanvas.width, p1.y * handCanvas.height);
        handCtx.lineTo(p2.x * handCanvas.width, p2.y * handCanvas.height);
    });
    handCtx.stroke();

    // Draw Joint Nodes with AR Glow
    lm.forEach((p, i) => {
        const isTip = (i === 4 || i === 8 || i === 12 || i === 16 || i === 20);
        handCtx.beginPath();
        handCtx.arc(p.x * handCanvas.width, p.y * handCanvas.height, isTip ? 6 : 3.5, 0, Math.PI * 2);
        handCtx.fillStyle = isTip ? '#ffffff' : color;
        handCtx.fill();
        if (isTip) {
            handCtx.strokeStyle = color;
            handCtx.lineWidth = 1.5;
            handCtx.stroke();
        }
    });
}

/**
 * SECTION 3: THREE.JS SETUP & MATERIALS
 */
function initThree() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.2, STATE.cameraDepth);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0); // Transparent for webcam layer
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 8, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    const pointLight = new THREE.PointLight(0x00ff88, 1.2, 10);
    pointLight.position.set(-3, 3, 2);
    scene.add(pointLight);

    // Spatial Reference Grid
    const grid = new THREE.GridHelper(12, 12, 0x00ff88, 0x1f2d3d);
    grid.position.y = -1.5;
    scene.add(grid);

    // Invisible Raycast Spatial Depth Plane (Facing Camera)
    const geo = new THREE.PlaneGeometry(100, 100);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    spatialPlane = new THREE.Mesh(geo, mat);
    scene.add(spatialPlane);

    raycaster = new THREE.Raycaster();

    // Resize Handler
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function createMaterial(matType) {
    switch (matType) {
        case 'GLASS':
            return new THREE.MeshPhysicalMaterial({
                color: CFG.COLORS.GLASS,
                metalness: 0.1,
                roughness: 0.1,
                transmission: 0.85,
                thickness: 0.5,
                transparent: true,
                opacity: 0.8,
                wireframe: false
            });
        case 'METAL':
            return new THREE.MeshStandardMaterial({
                color: 0xcccccc,
                metalness: 0.9,
                roughness: 0.2,
                wireframe: false
            });
        case 'NEON':
            return new THREE.MeshStandardMaterial({
                color: CFG.COLORS.PRIMARY,
                emissive: CFG.COLORS.PRIMARY,
                emissiveIntensity: 0.6,
                roughness: 0.3,
                wireframe: false
            });
        case 'HOLOGRAM':
        default:
            return new THREE.MeshStandardMaterial({
                color: CFG.COLORS.ACCENT,
                emissive: CFG.COLORS.ACCENT,
                emissiveIntensity: 0.4,
                wireframe: true
            });
    }
}

/**
 * SECTION 4: SPATIAL RAYCASTING & GEOMETRY CREATION
 */
function getSpatialPoint(lm) {
    if (!lm) return null;
    // Map MediaPipe screen [0,1] to Normalized Device Coords [-1, 1]
    // Note: webcam canvas is scaleX(-1) mirrored visually
    const ndcX = -((1 - lm.x) * 2 - 1);
    const ndcY = -(lm.y * 2 - 1);

    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);

    // Keep spatial plane aligned at camera target depth
    spatialPlane.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(STATE.cameraDepth));
    spatialPlane.lookAt(camera.position);

    const hits = raycaster.intersectObject(spatialPlane);
    return hits.length > 0 ? hits[0].point : null;
}

function spawnShapePrimitive(type, lm) {
    const pt = getSpatialPoint(lm);
    if (!pt) return;

    let geo;
    switch (type) {
        case 'CUBE':
            geo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
            break;
        case 'SPHERE':
            geo = new THREE.SphereGeometry(0.45, 32, 32);
            break;
        case 'CYLINDER':
            geo = new THREE.CylinderGeometry(0.35, 0.35, 0.8, 32);
            break;
        case 'CONE':
            geo = new THREE.ConeGeometry(0.4, 0.8, 32);
            break;
        case 'TORUS':
            geo = new THREE.TorusGeometry(0.4, 0.15, 16, 32);
            break;
        case 'PYRAMID':
            geo = new THREE.ConeGeometry(0.5, 0.7, 4);
            break;
        default:
            return;
    }

    const mat = createMaterial(STATE.selectedMaterial);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pt);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { shapeType: type, isPrimitive: true };

    scene.add(mesh);
    STATE.objects.push(mesh);
    selectObject(mesh);
    playSound('spawn');
}

function selectNearestObject(indexLm) {
    const pt = getSpatialPoint(indexLm);
    if (!pt) return;

    let closest = null;
    let minDst = 0.8;

    STATE.objects.forEach(obj => {
        const dst = obj.position.distanceTo(pt);
        if (dst < minDst) {
            minDst = dst;
            closest = obj;
        }
    });

    if (closest) {
        selectObject(closest);
    }
}

function selectObject(obj) {
    if (STATE.selectedObj && STATE.selectedObj !== obj) {
        unselectObject();
    }
    STATE.selectedObj = obj;
    if (obj.material && obj.material.emissive) {
        obj.material.emissive.setHex(0x33ffaa);
    }
    updateMetricsUI(obj);
}

function unselectObject() {
    if (STATE.selectedObj) {
        if (STATE.selectedObj.material && STATE.selectedObj.material.emissive) {
            const hex = STATE.selectedMaterial === 'NEON' ? CFG.COLORS.PRIMARY : (STATE.selectedMaterial === 'HOLOGRAM' ? CFG.COLORS.ACCENT : 0x000000);
            STATE.selectedObj.material.emissive.setHex(hex);
        }
        STATE.selectedObj = null;
    }
}

function finalizeDrawing() {
    if (STATE.currentLine) {
        STATE.currentLine.userData.isDrawing = false;
        STATE.objects.push(STATE.currentLine);
        selectObject(STATE.currentLine);
        STATE.currentLine = null;
        STATE.linePoints = [];
    }
    STATE.mode = 'IDLE';
}

/**
 * FIX: Safe Line Extrusion using BufferAttribute iteration
 */
function extrudeLastLine() {
    if (!STATE.objects.length) return;
    const targetObj = STATE.selectedObj || STATE.objects[STATE.objects.length - 1];
    if (!targetObj || targetObj.type !== 'Line' || targetObj.userData.isExtruded) return;

    const posAttr = targetObj.geometry.attributes.position;
    if (!posAttr || posAttr.count < 2) return;

    const pts = [];
    for (let i = 0; i < posAttr.count; i++) {
        pts.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
    }

    // Build smooth CatmullRom curve
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 64, 0.07, 12, false);
    const mat = createMaterial(STATE.selectedMaterial);
    const mesh = new THREE.Mesh(geo, mat);

    mesh.position.copy(targetObj.position);
    mesh.userData = { shapeType: 'Extruded Tube', isExtruded: true };

    scene.remove(targetObj);
    targetObj.geometry.dispose();
    const idx = STATE.objects.indexOf(targetObj);
    if (idx !== -1) STATE.objects.splice(idx, 1);

    scene.add(mesh);
    STATE.objects.push(mesh);
    selectObject(mesh);
    playSound('extrude');
}

/**
 * 3D LASER MEASUREMENT RULER LINE
 */
function updateLaserLine(p1, p2) {
    if (!laserLine) {
        const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        const mat = new THREE.LineDashedMaterial({
            color: CFG.COLORS.ACCENT,
            dashSize: 0.1,
            gapSize: 0.05,
            linewidth: 3
        });
        laserLine = new THREE.Line(geo, mat);
        laserLine.computeLineDistances();
        scene.add(laserLine);
    } else {
        laserLine.geometry.setFromPoints([p1, p2]);
        laserLine.geometry.computeBoundingSphere();
        laserLine.computeLineDistances();
        laserLine.visible = true;
    }
}

/**
 * SECTION 5: SPATIAL METRICS CALCULATIONS
 */
function updateMetricsUI(obj) {
    if (!obj || !obj.geometry) {
        mName.innerText = 'None';
        mVol.innerText = '0.00 u³';
        mArea.innerText = '0.00 u²';
        mBounds.innerText = '0 × 0 × 0';
        mVerts.innerText = '0 / 0';
        return;
    }

    obj.geometry.computeBoundingBox();
    const bbox = obj.geometry.boundingBox;
    const size = new THREE.Vector3();
    bbox.getSize(size);

    const type = obj.userData.shapeType || (obj.type === 'Line' ? '3D Curve' : 'Mesh');
    mName.innerText = type;
    mBounds.innerText = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;

    const metrics = computeMeshMetrics(obj.geometry, type, size);
    mVol.innerText = `${metrics.volume.toFixed(3)} u³`;
    mArea.innerText = `${metrics.area.toFixed(3)} u²`;
    mVerts.innerText = `${metrics.vertices} / ${metrics.edges}`;
}

function computeMeshMetrics(geo, type, size) {
    let volume = 0;
    let area = 0;
    let vertices = 0;
    let edges = 0;

    const posAttr = geo.attributes.position;
    if (posAttr) {
        vertices = posAttr.count;
        edges = Math.round(vertices * 1.5);
    }

    // Exact formulas for primitives, mesh sum for arbitrary geometry
    if (type === 'CUBE') {
        volume = size.x * size.y * size.z;
        area = 2 * (size.x * size.y + size.y * size.z + size.z * size.x);
    } else if (type === 'SPHERE') {
        const r = size.x / 2;
        volume = (4 / 3) * Math.PI * Math.pow(r, 3);
        area = 4 * Math.PI * Math.pow(r, 2);
    } else if (type === 'CYLINDER') {
        const r = size.x / 2;
        const h = size.y;
        volume = Math.PI * Math.pow(r, 2) * h;
        area = 2 * Math.PI * r * h + 2 * Math.PI * Math.pow(r, 2);
    } else if (type === 'CONE' || type === 'PYRAMID') {
        const r = size.x / 2;
        const h = size.y;
        volume = (1 / 3) * Math.PI * Math.pow(r, 2) * h;
        area = Math.PI * r * (r + Math.sqrt(h * h + r * r));
    } else if (type === 'TORUS') {
        const R = size.x / 2 - 0.15;
        const r = 0.15;
        volume = 2 * Math.pow(Math.PI, 2) * R * Math.pow(r, 2);
        area = 4 * Math.pow(Math.PI, 2) * R * r;
    } else {
        // Approximate Volume & Surface Area from Bounding Box / Buffer
        volume = size.x * size.y * size.z * 0.7;
        area = 2 * (size.x * size.y + size.y * size.z + size.z * size.x) * 0.8;
    }

    return { volume: Math.abs(volume), area: Math.abs(area), vertices, edges };
}

/**
 * SECTION 6: ANIMATION LOOP
 */
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    uiFps.innerText = Math.round(1 / (delta || 0.016));

    // Object Manipulation when Grabbed
    if (STATE.mode === 'GRABBED' && STATE.selectedObj && STATE.landmarks[0]) {
        const primaryLm = STATE.landmarks[0];
        const index = primaryLm[8];
        const wrist = primaryLm[0];
        const middle = primaryLm[12];

        const targetPos = getSpatialPoint(index);
        if (targetPos) {
            // Smoothly translate object to hand position
            STATE.selectedObj.position.lerp(targetPos, 0.2);
        }

        // Calculate hand tilt angle for smooth X/Y rotation
        const wristVec = new THREE.Vector3(wrist.x, wrist.y, wrist.z || 0);
        const midVec = new THREE.Vector3(middle.x, middle.y, middle.z || 0);
        const dir = midVec.sub(wristVec);

        STATE.selectedObj.rotation.x += dir.y * CFG.ROT_SENS;
        STATE.selectedObj.rotation.y += -dir.x * CFG.ROT_SENS;

        updateMetricsUI(STATE.selectedObj);
    }

    // 3D Freehand Drawing Logic
    if (STATE.mode === 'DRAWING' && STATE.landmarks[0]) {
        prompt.classList.remove('hidden');
        const pt = getSpatialPoint(STATE.landmarks[0][8]);

        if (pt) {
            crosshair.classList.remove('hidden');
            const screenVec = pt.clone().project(camera);
            crosshair.style.left = `${(screenVec.x * 0.5 + 0.5) * window.innerWidth}px`;
            crosshair.style.top = `${(-(screenVec.y * 0.5) + 0.5) * window.innerHeight}px`;

            if (!STATE.currentLine) {
                // Initialize line geometry with dynamic buffer attribute
                STATE.linePoints = [pt.x, pt.y, pt.z];
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                const mat = new THREE.LineBasicMaterial({ color: CFG.COLORS.PRIMARY, linewidth: 3 });
                STATE.currentLine = new THREE.Line(geo, mat);
                STATE.currentLine.userData = { shapeType: 'Freehand Line' };
                scene.add(STATE.currentLine);
            } else {
                // Append point efficiently without creating new Float32BufferAttribute
                STATE.linePoints.push(pt.x, pt.y, pt.z);
                const posAttr = STATE.currentLine.geometry.attributes.position;
                STATE.currentLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                STATE.currentLine.geometry.setDrawRange(0, STATE.linePoints.length / 3);
            }
        }
    } else {
        prompt.classList.add('hidden');
        crosshair.classList.add('hidden');
    }

    // Idle Object Slow Rotation for Visual Polish
    STATE.objects.forEach(obj => {
        if (obj !== STATE.selectedObj && obj.userData.isPrimitive) {
            obj.rotation.y += 0.005;
        }
    });

    renderer.render(scene, camera);
}

/**
 * SECTION 7: UI EVENT HANDLERS & TOOLBAR BINDINGS
 */
function setupUIHandlers() {
    initAudio();

    // Shape Primitive Selection
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            STATE.selectedShape = target.dataset.shape;
            playSound('pinch');
        });
    });

    // Material Shader Selection
    document.querySelectorAll('.mat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.mat-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            STATE.selectedMaterial = target.dataset.mat;

            // Apply material live to selected object if any
            if (STATE.selectedObj && STATE.selectedObj.type === 'Mesh') {
                STATE.selectedObj.material = createMaterial(STATE.selectedMaterial);
            }
            playSound('pinch');
        });
    });

    // Action Buttons
    document.getElementById('btn-extrude').onclick = () => extrudeLastLine();

    document.getElementById('btn-reset').onclick = () => {
        STATE.objects.forEach(o => { scene.remove(o); o.geometry.dispose(); });
        STATE.objects = [];
        unselectObject();
        updateMetricsUI(null);
        playSound('clear');
    };

    document.getElementById('btn-skeleton').onclick = (e) => {
        STATE.showSkeleton = !STATE.showSkeleton;
        e.currentTarget.innerText = STATE.showSkeleton ? "🖐️ Skeleton: ON" : "🖐️ Skeleton: OFF";
    };

    document.getElementById('btn-sfx').onclick = (e) => {
        STATE.enableSFX = !STATE.enableSFX;
        e.currentTarget.innerText = STATE.enableSFX ? "🔊 SFX: ON" : "🔇 SFX: OFF";
    };
}

function updateUI(conf) {
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `MODE: ${STATE.mode}`;

    if (STATE.gesture === 'PINCH') uiGesture.style.color = '#ffaa00';
    else if (STATE.gesture === 'GRAB') uiGesture.style.color = '#ff3366';
    else if (STATE.gesture === 'TWO_HAND') uiGesture.style.color = '#00ccff';
    else uiGesture.style.color = '#00ff88';

    const pct = Math.min(100, Math.round(conf * 100));
    uiTrack.style.width = `${pct}%`;
    uiTrackVal.innerText = `${pct}%`;
}

/**
 * SECTION 8: MOUSE FALLBACK TESTING FOR DESKTOP WITHOUT WEBCAM
 */
function enableMouseFallback() {
    let isMouseDown = false;

    window.addEventListener('mousedown', (e) => {
        if (e.target.closest('.panel')) return; // Ignore clicks on UI panel
        isMouseDown = true;
        initAudio();

        const mouseLm = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
        STATE.landmarks = [[mouseLm]];

        if (STATE.selectedShape === 'DRAW') {
            STATE.mode = 'DRAWING';
            STATE.gesture = 'PINCH';
        } else {
            spawnShapePrimitive(STATE.selectedShape, mouseLm);
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!isMouseDown) return;
        const mouseLm = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
        STATE.landmarks = [[mouseLm]];
    });

    window.addEventListener('mouseup', () => {
        if (isMouseDown) {
            isMouseDown = false;
            if (STATE.mode === 'DRAWING') finalizeDrawing();
            STATE.mode = 'IDLE';
            STATE.gesture = 'OPEN';
        }
    });
}

// APPLICATION STARTUP
initThree();
setupUIHandlers();
initMediaPipe();
animate();
