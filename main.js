import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * CONFIGURATION & CONSTANTS
 */
const CFG = {
    SMOOTHING: 0.35,
    PINCH_ENTER: 0.038, // Tight pinch to prevent accidental triggers during hand waving
    PINCH_EXIT: 0.058,
    GRAB_DIST: 0.28,
    ROT_SENS: 0.08,
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
    mode: 'IDLE', // IDLE, DRAWING, GRABBED, EXTRUDING, MEASURING, HOLOGRAPHIC
    gesture: 'NONE',
    selectedShape: 'SELECT', // Default to SELECT/GRAB mode to prevent accidental drawing when waving hand!
    selectedMaterial: 'HOLOGRAM',
    hands: [],
    landmarks: [],
    objects: [],
    selectedObj: null, // Active Target Object (Iron Man single object isolation)
    selectionBox: null,
    currentLine: null,
    linePoints: [],
    showSkeleton: true,
    enableSFX: true,
    isPinching: false,
    pinchFrameCount: 0,
    cameraDepth: 3.5,
    isDraggingObj: false,
    
    // Single-Hand & Dual-Hand Zoom State
    hoveredUIElement: null,
    initPinchPos: null,
    initPinchScale: 1.0,
    initTwoHandDistance: null,
    initTwoHandScale: 1.0,
    initTwoHandAngle: 0,
    initCameraZ: 3.5
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

// TRANSFORM SLIDER & BUTTONS
const scaleSlider = document.getElementById('scale-slider');
const scaleVal = document.getElementById('scale-val');

// THREE.JS GLOBALS
let scene, camera, renderer, raycaster, spatialPlane, laserLine, orbitControls;
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

    if (type === 'pinch' || type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(1040, now + 0.1);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'autocomplete') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.2);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
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
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.15);
        gain.gain.setValueAtTime(0.22, now);
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
        });
}

function onHandsResults(results) {
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
        clearUIHover();
        STATE.pinchFrameCount = 0;
        STATE.initPinchPos = null;
        if (!STATE.isDraggingObj) STATE.mode = 'IDLE';
        updateUI(0);
        return;
    }

    // PHASE 1: Collect & Smooth Landmarks
    STATE.hands.forEach((lmList, idx) => {
        if (!prevLandmarks[idx]) prevLandmarks[idx] = [];
        const smoothed = lmList.map((lm, i) => {
            prevLandmarks[idx][i] = smoothLandmark(lm, prevLandmarks[idx][i], CFG.SMOOTHING);
            return prevLandmarks[idx][i];
        });
        STATE.landmarks.push(smoothed);
        totalConf += 0.9;

        if (STATE.showSkeleton) drawSkeleton(smoothed, idx);
    });

    // PHASE 2: Primary Hand Gesture Analysis
    const primaryLm = STATE.landmarks[0];
    const thumb = primaryLm[4];
    const index = primaryLm[8];
    const middle = primaryLm[12];
    const ring = primaryLm[16];
    const pinky = primaryLm[20];
    const wrist = primaryLm[0];

    const pinchDist = getDistance(thumb, index);
    const handScale = getDistance(wrist, primaryLm[9]) || 0.2;
    const isGrabbed = (
        getDistance(index, wrist) / handScale < 1.3 &&
        getDistance(middle, wrist) / handScale < 1.3 &&
        getDistance(ring, wrist) / handScale < 1.3 &&
        getDistance(pinky, wrist) / handScale < 1.3
    );

    processOculusHandPointer(index, pinchDist);

    // ANTI-ACCIDENTAL DRAWING: Require tight pinch held for 2+ consecutive frames
    if (pinchDist < CFG.PINCH_ENTER) {
        STATE.pinchFrameCount++;
    } else if (pinchDist > CFG.PINCH_EXIT) {
        STATE.pinchFrameCount = 0;
        STATE.isPinching = false;
        STATE.initPinchPos = null;
    }

    if (!STATE.isPinching && STATE.pinchFrameCount >= 2) {
        STATE.isPinching = true;
        playSound('pinch');
        if (STATE.hoveredUIElement) {
            STATE.hoveredUIElement.click();
            playSound('click');
        }
    }

    // PHASE 3: Iron Man Single-Hand Pinch & Pull Zoom + 2-Hand Zoom
    let isTwoHand = false;
    if (STATE.landmarks.length === 2) {
        const h1 = STATE.landmarks[0][8];
        const h2 = STATE.landmarks[1][8];
        
        if (h1 && h2) {
            const pt1 = getSpatialPoint(h1);
            const pt2 = getSpatialPoint(h2);
            
            if (pt1 && pt2) {
                isTwoHand = true;
                const currentDist = pt1.distanceTo(pt2);

                const p1Pinch = getDistance(STATE.landmarks[0][4], STATE.landmarks[0][8]) < CFG.PINCH_EXIT;
                const p2Pinch = getDistance(STATE.landmarks[1][4], STATE.landmarks[1][8]) < CFG.PINCH_EXIT;

                if (p1Pinch && p2Pinch) {
                    STATE.gesture = 'DUAL_PINCH_ZOOM';
                    STATE.mode = 'HOLOGRAPHIC';

                    if (STATE.initTwoHandDistance === null) {
                        STATE.initTwoHandDistance = currentDist;
                        STATE.initTwoHandScale = STATE.selectedObj ? STATE.selectedObj.scale.x : 1.0;
                        STATE.initCameraZ = camera.position.z;
                    } else {
                        const ratio = currentDist / STATE.initTwoHandDistance;

                        if (STATE.selectedObj) {
                            // Scale Exclusive Active Target Object ONLY
                            const newScale = Math.max(0.2, Math.min(5.0, STATE.initTwoHandScale * ratio));
                            STATE.selectedObj.scale.set(newScale, newScale, newScale);
                            if (STATE.selectionBox) STATE.selectionBox.update();
                            scaleSlider.value = newScale;
                            scaleVal.innerText = `${newScale.toFixed(1)}×`;
                            updateMetricsUI(STATE.selectedObj);

                            rulerDisplay.classList.remove('hidden');
                            rulerVal.innerText = `ACTIVE SHAPE SCALE: ${newScale.toFixed(2)}×`;
                        } else {
                            const newZ = Math.max(1.5, Math.min(8.0, STATE.initCameraZ / ratio));
                            camera.position.z = THREE.MathUtils.lerp(camera.position.z, newZ, 0.15);

                            rulerDisplay.classList.remove('hidden');
                            rulerVal.innerText = `IRON MAN SCENE ZOOM: ${ratio.toFixed(2)}×`;
                        }
                    }

                    updateLaserLine(pt1, pt2);

                } else {
                    STATE.initTwoHandDistance = null;
                    rulerDisplay.classList.remove('hidden');
                    rulerVal.innerText = `${currentDist.toFixed(2)} m`;
                    updateLaserLine(pt1, pt2);

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
        }
    } else {
        if (laserLine) laserLine.visible = false;
        rulerDisplay.classList.add('hidden');
        STATE.initTwoHandDistance = null;
    }

    // SINGLE-HAND PINCH & PULL ZOOM (when in SELECT mode or active object selected)
    if (!isTwoHand && STATE.isPinching && STATE.selectedShape === 'SELECT') {
        const pPt = getSpatialPoint(index);
        if (pPt) {
            if (!STATE.initPinchPos) {
                STATE.initPinchPos = pPt.clone();
                STATE.initPinchScale = STATE.selectedObj ? STATE.selectedObj.scale.x : 1.0;
            } else {
                // Vertical / Z depth pinch drag distance
                const dy = (pPt.y - STATE.initPinchPos.y) * 2.5;
                if (Math.abs(dy) > 0.05) {
                    STATE.gesture = 'SINGLE_PINCH_ZOOM';
                    const newScale = Math.max(0.2, Math.min(5.0, STATE.initPinchScale * (1 + dy)));
                    
                    if (STATE.selectedObj) {
                        STATE.selectedObj.scale.set(newScale, newScale, newScale);
                        if (STATE.selectionBox) STATE.selectionBox.update();
                        scaleSlider.value = newScale;
                        scaleVal.innerText = `${newScale.toFixed(1)}×`;
                        updateMetricsUI(STATE.selectedObj);

                        rulerDisplay.classList.remove('hidden');
                        rulerVal.innerText = `1-HAND ZOOM: ${newScale.toFixed(2)}×`;
                    }
                }
            }
        }
    }

    // PHASE 4: Primary Gesture State Machine
    if (!isTwoHand && STATE.gesture !== 'SINGLE_PINCH_ZOOM') {
        if (STATE.isPinching) {
            STATE.gesture = 'PINCH';
            if (STATE.selectedShape === 'DRAW' && !STATE.hoveredUIElement) {
                if (STATE.mode !== 'DRAWING') {
                    STATE.mode = 'DRAWING';
                }
            } else if (STATE.selectedShape !== 'SELECT' && !STATE.hoveredUIElement) {
                spawnShapePrimitive(STATE.selectedShape, index);
                STATE.isPinching = false;
            } else if (STATE.selectedShape === 'SELECT' && !STATE.hoveredUIElement) {
                // Try selecting target shape under index finger
                selectNearestObject(index);
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
            if (!STATE.isDraggingObj) STATE.mode = 'IDLE';
        }
    }

    updateUI(totalConf / (STATE.hands.length || 1));
}

function processOculusHandPointer(indexLm, pinchDist) {
    if (!indexLm) {
        clearUIHover();
        return;
    }
    const screenX = (1 - indexLm.x) * window.innerWidth;
    const screenY = indexLm.y * window.innerHeight;

    const elem = document.elementFromPoint(screenX, screenY);
    const targetBtn = elem ? elem.closest('button, .tool-btn, .mat-btn, .btn-action, .sm-btn, .btn-toggle-panel') : null;

    if (targetBtn) {
        if (STATE.hoveredUIElement !== targetBtn) {
            clearUIHover();
            STATE.hoveredUIElement = targetBtn;
            targetBtn.classList.add('hand-hover');
        }
    } else {
        clearUIHover();
    }
}

function clearUIHover() {
    if (STATE.hoveredUIElement) {
        STATE.hoveredUIElement.classList.remove('hand-hover');
        STATE.hoveredUIElement = null;
    }
}

function drawSkeleton(lm, handIdx) {
    const color = handIdx === 0 ? '#00ff88' : '#00ccff';
    handCtx.strokeStyle = color;
    handCtx.lineWidth = 2.5;
    handCtx.beginPath();

    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [0, 9], [9, 10], [10, 11], [11, 12],
        [0, 13], [13, 14], [14, 15], [15, 16],
        [0, 17], [17, 18], [18, 19], [19, 20],
        [5, 9], [9, 13], [13, 17]
    ];

    connections.forEach(([i, j]) => {
        const p1 = lm[i];
        const p2 = lm[j];
        handCtx.moveTo(p1.x * handCanvas.width, p1.y * handCanvas.height);
        handCtx.lineTo(p2.x * handCanvas.width, p2.y * handCanvas.height);
    });
    handCtx.stroke();

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

    const indexTip = lm[8];
    if (indexTip && handIdx === 0) {
        handCtx.beginPath();
        handCtx.arc(indexTip.x * handCanvas.width, indexTip.y * handCanvas.height, STATE.isPinching ? 9 : 14, 0, Math.PI * 2);
        handCtx.strokeStyle = STATE.isPinching ? '#00ff88' : '#00ccff';
        handCtx.lineWidth = 2;
        handCtx.stroke();
        if (STATE.isPinching) {
            handCtx.fillStyle = 'rgba(0, 255, 136, 0.4)';
            handCtx.fill();
        }
    }
}

/**
 * SECTION 3: THREE.JS SETUP
 */
function initThree() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.2, STATE.cameraDepth);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;
    orbitControls.screenSpacePanning = true;
    orbitControls.maxPolarAngle = Math.PI / 2 + 0.1;

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

    const grid = new THREE.GridHelper(12, 12, 0x00ff88, 0x1f2d3d);
    grid.position.y = -1.5;
    scene.add(grid);

    const geo = new THREE.PlaneGeometry(100, 100);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    spatialPlane = new THREE.Mesh(geo, mat);
    scene.add(spatialPlane);

    raycaster = new THREE.Raycaster();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    setupMouseInteractions();
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
 * SECTION 4: SPATIAL RAYCASTING & SINGLE ACTIVE OBJECT ISOLATION
 */
function getSpatialPoint(lm) {
    if (!lm) return null;
    const ndcX = 1 - 2 * lm.x;
    const ndcY = -(lm.y * 2 - 1);

    const mouse = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(mouse, camera);

    spatialPlane.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(STATE.cameraDepth));
    spatialPlane.lookAt(camera.position);

    const hits = raycaster.intersectObject(spatialPlane);
    return hits.length > 0 ? hits[0].point : null;
}

function getSpatialPointFromMouse(e) {
    const mouse = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);

    spatialPlane.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(STATE.cameraDepth));
    spatialPlane.lookAt(camera.position);

    const hits = raycaster.intersectObject(spatialPlane);
    return hits.length > 0 ? hits[0].point : null;
}

function spawnShapePrimitive(type, lm) {
    const pt = lm.x !== undefined ? getSpatialPoint(lm) : getSpatialPointFromMouse(lm);
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

    if (closest) selectObject(closest);
}

// IRON MAN SINGLE ACTIVE OBJECT FOCUS
function selectObject(obj) {
    if (STATE.selectedObj && STATE.selectedObj !== obj) {
        unselectObject();
    }
    STATE.selectedObj = obj;

    if (!STATE.selectionBox) {
        STATE.selectionBox = new THREE.BoxHelper(obj, 0x00ff88);
        scene.add(STATE.selectionBox);
    } else {
        STATE.selectionBox.setFromObject(obj);
        STATE.selectionBox.visible = true;
    }

    if (obj.material && obj.material.emissive) {
        obj.material.emissive.setHex(0x33ffaa);
    }

    const currentScale = obj.scale.x;
    scaleSlider.value = currentScale;
    scaleVal.innerText = `${currentScale.toFixed(1)}×`;

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
    if (STATE.selectionBox) {
        STATE.selectionBox.visible = false;
    }
    updateMetricsUI(null);
}

function finalizeDrawing() {
    if (STATE.currentLine && STATE.linePoints.length >= 6) {
        const pts = [];
        for (let i = 0; i < STATE.linePoints.length; i += 3) {
            pts.push(new THREE.Vector3(STATE.linePoints[i], STATE.linePoints[i + 1], STATE.linePoints[i + 2]));
        }

        const startPt = pts[0];
        const endPt = pts[pts.length - 1];
        const distStartEnd = startPt.distanceTo(endPt);

        const bbox = new THREE.Box3().setFromPoints(pts);
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        const size = new THREE.Vector3();
        bbox.getSize(size);

        scene.remove(STATE.currentLine);
        STATE.currentLine.geometry.dispose();

        if (distStartEnd < 0.65 || pts.length > 25) {
            const radii = pts.map(p => p.distanceTo(center));
            const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
            const radiusVariance = radii.reduce((acc, r) => acc + Math.abs(r - avgRadius), 0) / radii.length;
            const varianceRatio = radiusVariance / avgRadius;

            let completedMesh;
            if (varianceRatio < 0.28) {
                const geo = new THREE.SphereGeometry(avgRadius, 32, 32);
                const mat = createMaterial(STATE.selectedMaterial);
                completedMesh = new THREE.Mesh(geo, mat);
                completedMesh.userData = { shapeType: 'Auto-Sphere', isPrimitive: true };
                playSound('autocomplete');
            } else {
                const maxDim = Math.max(size.x, size.y, size.z, 0.4);
                const geo = new THREE.BoxGeometry(maxDim, maxDim, maxDim);
                const mat = createMaterial(STATE.selectedMaterial);
                completedMesh = new THREE.Mesh(geo, mat);
                completedMesh.userData = { shapeType: 'Auto-Cube', isPrimitive: true };
                playSound('autocomplete');
            }

            completedMesh.position.copy(center);
            scene.add(completedMesh);
            STATE.objects.push(completedMesh);
            selectObject(completedMesh);

        } else {
            const curve = new THREE.CatmullRomCurve3(pts);
            const smoothPts = curve.getPoints(64);
            const geo = new THREE.BufferGeometry().setFromPoints(smoothPts);
            const mat = new THREE.LineBasicMaterial({ color: CFG.COLORS.PRIMARY, linewidth: 3 });
            const line = new THREE.Line(geo, mat);
            line.userData = { shapeType: 'Smooth 3D Curve' };

            scene.add(line);
            STATE.objects.push(line);
            selectObject(line);
        }

        STATE.currentLine = null;
        STATE.linePoints = [];
    }
    STATE.mode = 'IDLE';
}

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
 * SECTION 5: MOUSE / POINTER INTERACTION
 */
function setupMouseInteractions() {
    let activePointerDown = false;

    webglCanvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        initAudio();

        const mouse = new THREE.Vector2(
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1
        );
        raycaster.setFromCamera(mouse, camera);

        const hits = raycaster.intersectObjects(STATE.objects, true);
        if (hits.length > 0) {
            const hitObj = hits[0].object;
            selectObject(hitObj);
            STATE.isDraggingObj = true;
            orbitControls.enabled = false;
            activePointerDown = true;
        } else if (STATE.selectedShape !== 'DRAW' && STATE.selectedShape !== 'SELECT') {
            spawnShapePrimitive(STATE.selectedShape, e);
        } else {
            unselectObject();
        }
    });

    webglCanvas.addEventListener('pointermove', (e) => {
        if (STATE.isDraggingObj && STATE.selectedObj && activePointerDown) {
            const pt = getSpatialPointFromMouse(e);
            if (pt) {
                STATE.selectedObj.position.copy(pt);
                if (STATE.selectionBox) STATE.selectionBox.update();
                updateMetricsUI(STATE.selectedObj);
            }
        }
    });

    const endDrag = () => {
        if (STATE.isDraggingObj) {
            STATE.isDraggingObj = false;
            orbitControls.enabled = true;
            activePointerDown = false;
        }
    };

    webglCanvas.addEventListener('pointerup', endDrag);
    webglCanvas.addEventListener('pointercancel', endDrag);

    webglCanvas.addEventListener('wheel', (e) => {
        if (STATE.selectedObj) {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.1 : -0.1;
            const newScale = Math.max(0.2, Math.min(5.0, STATE.selectedObj.scale.x + delta));
            STATE.selectedObj.scale.set(newScale, newScale, newScale);
            if (STATE.selectionBox) STATE.selectionBox.update();
            scaleSlider.value = newScale;
            scaleVal.innerText = `${newScale.toFixed(1)}×`;
            updateMetricsUI(STATE.selectedObj);
        }
    }, { passive: false });
}

/**
 * SECTION 6: SPATIAL METRICS CALCULATIONS
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
    size.multiply(obj.scale);

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

    if (type === 'CUBE' || type === 'Auto-Cube') {
        volume = size.x * size.y * size.z;
        area = 2 * (size.x * size.y + size.y * size.z + size.z * size.x);
    } else if (type === 'SPHERE' || type === 'Auto-Sphere') {
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
        volume = size.x * size.y * size.z * 0.7;
        area = 2 * (size.x * size.y + size.y * size.z + size.z * size.x) * 0.8;
    }

    return { volume: Math.abs(volume), area: Math.abs(area), vertices, edges };
}

/**
 * SECTION 7: ANIMATION LOOP & EXCLUSIVE ACTIVE OBJECT FOCUS
 */
function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    uiFps.innerText = Math.round(1 / (delta || 0.016));

    orbitControls.update();

    if (STATE.selectionBox && STATE.selectedObj) {
        STATE.selectionBox.update();
    }

    // EXCLUSIVE ACTIVE TARGET OBJECT MANIPULATION (TONY STARK ISOLATION)
    if (STATE.mode === 'GRABBED' && STATE.selectedObj && STATE.landmarks[0]) {
        const primaryLm = STATE.landmarks[0];
        const index = primaryLm[8];
        const wrist = primaryLm[0];
        const middle = primaryLm[12];
        const pinky = primaryLm[20];
        const thumb = primaryLm[4];

        // 1. Position Translation on Active Object
        const targetPos = getSpatialPoint(index);
        if (targetPos) {
            STATE.selectedObj.position.lerp(targetPos, 0.22);
        }

        // 2. 6-DOF Wrist/Palm Orientation on Active Object ONLY
        const pitchAngle = (middle.y - wrist.y) * 4.0;
        const yawAngle = -(index.x - pinky.x) * 4.0;
        const rollAngle = Math.atan2(thumb.y - pinky.y, thumb.x - pinky.x);

        STATE.selectedObj.rotation.x = THREE.MathUtils.lerp(STATE.selectedObj.rotation.x, pitchAngle, 0.1);
        STATE.selectedObj.rotation.y = THREE.MathUtils.lerp(STATE.selectedObj.rotation.y, yawAngle, 0.1);
        STATE.selectedObj.rotation.z = THREE.MathUtils.lerp(STATE.selectedObj.rotation.z, rollAngle, 0.1);

        updateMetricsUI(STATE.selectedObj);
    }

    // 3D Freehand Drawing Logic (ONLY active in explicit DRAW mode)
    if (STATE.mode === 'DRAWING' && STATE.selectedShape === 'DRAW' && STATE.landmarks[0]) {
        prompt.classList.remove('hidden');
        const pt = getSpatialPoint(STATE.landmarks[0][8]);

        if (pt) {
            crosshair.classList.remove('hidden');
            const screenVec = pt.clone().project(camera);
            crosshair.style.left = `${(screenVec.x * 0.5 + 0.5) * window.innerWidth}px`;
            crosshair.style.top = `${(-(screenVec.y * 0.5) + 0.5) * window.innerHeight}px`;

            if (!STATE.currentLine) {
                STATE.linePoints = [pt.x, pt.y, pt.z];
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                const mat = new THREE.LineBasicMaterial({ color: CFG.COLORS.PRIMARY, linewidth: 3 });
                STATE.currentLine = new THREE.Line(geo, mat);
                STATE.currentLine.userData = { shapeType: 'Freehand Line' };
                scene.add(STATE.currentLine);
            } else {
                STATE.linePoints.push(pt.x, pt.y, pt.z);
                STATE.currentLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(STATE.linePoints, 3));
                STATE.currentLine.geometry.setDrawRange(0, STATE.linePoints.length / 3);
            }
        }
    } else {
        prompt.classList.add('hidden');
        crosshair.classList.add('hidden');
    }

    renderer.render(scene, camera);
}

/**
 * SECTION 8: UI EVENT HANDLERS & MODAL CONTROLS
 */
function setupUIHandlers() {
    initAudio();

    document.querySelectorAll('.btn-toggle-panel').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const panel = document.getElementById(e.currentTarget.dataset.target);
            if (panel) {
                panel.classList.toggle('collapsed');
                e.currentTarget.innerText = panel.classList.contains('collapsed') ? '+' : '−';
            }
        });
    });

    const guideModal = document.getElementById('gesture-guide-modal');
    document.getElementById('btn-guide-toggle').onclick = () => {
        guideModal.classList.remove('hidden');
        playSound('pinch');
    };
    document.getElementById('btn-close-guide').onclick = () => {
        guideModal.classList.add('hidden');
    };

    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            STATE.selectedShape = target.dataset.shape;
            playSound('pinch');
        });
    });

    document.querySelectorAll('.mat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.mat-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            STATE.selectedMaterial = target.dataset.mat;

            if (STATE.selectedObj && STATE.selectedObj.type === 'Mesh') {
                STATE.selectedObj.material = createMaterial(STATE.selectedMaterial);
            }
            playSound('pinch');
        });
    });

    scaleSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        scaleVal.innerText = `${val.toFixed(1)}×`;
        if (STATE.selectedObj) {
            STATE.selectedObj.scale.set(val, val, val);
            if (STATE.selectionBox) STATE.selectionBox.update();
            updateMetricsUI(STATE.selectedObj);
        }
    });

    document.getElementById('btn-rot-x').onclick = () => {
        if (STATE.selectedObj) {
            STATE.selectedObj.rotation.x += Math.PI / 4;
            if (STATE.selectionBox) STATE.selectionBox.update();
        }
    };

    document.getElementById('btn-rot-y').onclick = () => {
        if (STATE.selectedObj) {
            STATE.selectedObj.rotation.y += Math.PI / 4;
            if (STATE.selectionBox) STATE.selectionBox.update();
        }
    };

    document.getElementById('btn-rot-z').onclick = () => {
        if (STATE.selectedObj) {
            STATE.selectedObj.rotation.z += Math.PI / 4;
            if (STATE.selectionBox) STATE.selectionBox.update();
        }
    };

    document.getElementById('btn-delete').onclick = () => deleteSelectedObject();
    document.getElementById('btn-extrude').onclick = () => extrudeLastLine();

    document.getElementById('btn-reset').onclick = () => {
        STATE.objects.forEach(o => { scene.remove(o); o.geometry.dispose(); });
        STATE.objects = [];
        unselectObject();
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

function deleteSelectedObject() {
    if (!STATE.selectedObj) return;
    const obj = STATE.selectedObj;
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    const idx = STATE.objects.indexOf(obj);
    if (idx !== -1) STATE.objects.splice(idx, 1);
    unselectObject();
    playSound('clear');
}

function updateUI(conf) {
    uiGesture.innerText = STATE.gesture;
    uiMode.innerText = `MODE: ${STATE.selectedShape}`;

    if (STATE.gesture === 'PINCH') uiGesture.style.color = '#ffaa00';
    else if (STATE.gesture === 'GRAB') uiGesture.style.color = '#ff3366';
    else if (STATE.gesture === 'TWO_HAND' || STATE.gesture === 'DUAL_PINCH_ZOOM' || STATE.gesture === 'SINGLE_PINCH_ZOOM') uiGesture.style.color = '#00ccff';
    else uiGesture.style.color = '#00ff88';

    const pct = Math.min(100, Math.round(conf * 100));
    uiTrack.style.width = `${pct}%`;
    uiTrackVal.innerText = `${pct}%`;
}

// APPLICATION STARTUP
initThree();
setupUIHandlers();
initMediaPipe();
animate();
