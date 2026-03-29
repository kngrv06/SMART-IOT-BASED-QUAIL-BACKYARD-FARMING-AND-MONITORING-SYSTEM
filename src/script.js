import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    addDoc,
    query,
    orderBy,
    limit,
    getDocs,
    serverTimestamp,
    deleteDoc,
    doc,
    onSnapshot,
    where,
    setDoc,
    Timestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyAiWKZaly3dPspMIzfgy7q9pLYEHBTxBAI",
    authDomain: "smart-quial.firebaseapp.com",
    databaseURL: "https://smart-quial-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "smart-quial",
    storageBucket: "smart-quial.firebasestorage.app",
    messagingSenderId: "144709205906",
    appId: "1:144709205906:web:94caf405b3568b03c74b4b"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Firestore Error Handling ---
const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Blynk Configuration
const blynkConfig = {
    baseUrl: '/api/blynk',
    pollInterval: 5000, 
};

// Calibration Settings (Adjust these based on your actual sensor)
const CALIBRATION = {
    V3_EMPTY: 0,  // Ang value na ito ay magiging 0% (Wala pang laman)
    V3_FULL: 100  // Default 100, i-adjust kung kailangan
};

// State Management
let isAuthModeLogin = true;
let currentUser = null;
let pollTimer = null;
let firebaseLogTimer = null;
let hourlyTimer = null;
let tempChart = null;
let humChart = null;
let ammChart = null;

// Track manual overrides to prevent polling from flickering the UI
let manualOverrides = {};

let farmState = {
    v0: 0, v1: 0, v2: 0, v3: 0,
    v10: 0, v11: 0, v12: 0, v13: 0,
    v20: 3, v21: 420, // Default 7:00 AM
    v22: 20, v23: 480, // Default 8:00 AM
    v24: 1080, v25: 360, // Default 18:00 to 06:00
    isOnline: false,
    isAutoMode: localStorage.getItem('auto_mode') === 'true'
};

// Clear stale local data for production launch
if (!localStorage.getItem('prod_launched_v1')) {
    localStorage.removeItem('hourly_data');
    localStorage.removeItem('last_firebase_log_time');
    localStorage.removeItem('last_manual_feed_time');
    localStorage.setItem('prod_launched_v1', 'true');
}

// Hourly Data for Graph
let hourlyData = JSON.parse(localStorage.getItem('hourly_data')) || [];
let sensorLogs = []; // For Firestore logs
let selectedHistoryDate = null; // For tabbed history view

async function syncHistoryWithServer() {
    try {
        // Fetch from Firestore instead of local server for defense
        const q = query(collection(db, "sensor_logs"), orderBy("timestamp", "desc"), limit(200));
        const querySnapshot = await getDocs(q);
        const logs = [];
        querySnapshot.forEach((doc) => {
            logs.push(doc.data());
        });
        
        if (logs.length > 0) {
            sensorLogs = logs;
            renderHistory();
            
            // Update hourly trends for graphs
            const trends = [...logs].reverse().slice(-24);
            hourlyData = trends.map(l => ({
                time: l.timeStr,
                temp: l.temperature || 0,
                hum: l.humidity || 0,
                amm: l.ammonia || 0,
                timestamp: l.timestamp?.seconds * 1000 || Date.now()
            }));
            updateChart();
        }
    } catch (e) {
        console.error("Sync error:", e);
    }
}

let lastLogTime = parseInt(localStorage.getItem('last_firebase_log_time')) || 0;
const LOG_COOLDOWN = 55 * 60 * 1000; // 55 minutes cooldown

async function logToFirebase(isManual = false) {
    if (!currentUser) return;
    
    const now = new Date();
    const currentTime = now.getTime();
    
    // Prevent duplicate logs if not manual and within cooldown
    if (!isManual && (currentTime - lastLogTime < LOG_COOLDOWN)) {
        console.log("Skipping hourly log: cooldown active.");
        return;
    }
    
    lastLogTime = currentTime;
    localStorage.setItem('last_firebase_log_time', lastLogTime);
    const dateStr = now.toLocaleDateString();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const logEntry = {
        temperature: farmState.v0,
        humidity: farmState.v1,
        ammonia: farmState.v2,
        feedLevel: Math.max(0, Math.min(100, ((farmState.v3 - CALIBRATION.V3_EMPTY) / (CALIBRATION.V3_FULL - CALIBRATION.V3_EMPTY)) * 100)),
        timestamp: serverTimestamp(),
        dateStr,
        timeStr,
        userId: currentUser.uid
    };

    try {
        console.log("Attempting to log to Firebase. Current farmState:", farmState);
        
        if (farmState.v0 === 0 && farmState.v1 === 0 && farmState.v2 === 0) {
            console.warn("Sensor values are all 0. Skipping log to avoid polluting database with initial/empty data.");
            return;
        }

        console.log("Logging to Firebase:", logEntry);
        
        // Log to history collection
        try {
            await addDoc(collection(db, "sensor_logs"), logEntry);
        } catch (e) {
            handleFirestoreError(e, OperationType.CREATE, "sensor_logs");
        }
        
        // Also update the specific "Latest" document requested by the user
        const latestDocRef = doc(db, "sensor_logs", "XYiDZz0uH1xk0IL7KjK3");
        try {
            await setDoc(latestDocRef, {
                temperature: logEntry.temperature,
                humidity: logEntry.humidity,
                ammonia: logEntry.ammonia,
                feedLevel: logEntry.feedLevel,
                lastUpdate: serverTimestamp()
            }, { merge: true });
        } catch (e) {
            handleFirestoreError(e, OperationType.WRITE, "sensor_logs/XYiDZz0uH1xk0IL7KjK3");
        }

        addLog("Data logged to Firebase Firestore (History & Latest).");
        syncHistoryWithServer();
    } catch (e) {
        console.error("Firebase log error:", e);
    }
}

// Mock History Data
let farmHistory = [];

// UI Elements
const authOverlay = document.getElementById('auth-overlay');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const toggleAuthModeBtn = document.getElementById('toggle-auth-mode');
const authSubtitle = document.getElementById('auth-subtitle');
const logoutBtn = document.getElementById('logout-btn');
const logoutBtnMenu = document.getElementById('logout-btn-menu');
const userDisplayName = document.getElementById('user-display-name');
const terminalLog = document.getElementById('terminal-log');
const currentTimeDisplay = document.getElementById('current-time');
const currentDateDisplay = document.getElementById('current-date');
const enableNotifsBtn = document.getElementById('enable-notifs');
const profileTrigger = document.getElementById('profile-trigger');
const profileMenu = document.getElementById('profile-menu');
const autoModeToggle = document.getElementById('auto-mode-toggle');
const generateReportBtn = document.getElementById('generate-report-btn');

// --- Authentication Logic ---



// Helper functions for data aggregation
function formatAverageTable(title, data) {
    if (!data || data.length === 0) return '';
    
    let rows = data.map(item => `
        <tr class="border-b border-stone-100">
            <td class="p-3 font-bold text-stone-900">${item.label}</td>
            <td class="p-3">${item.temp}°C</td>
            <td class="p-3">${item.hum}%</td>
            <td class="p-3">${item.amm}</td>
        </tr>
    `).join('');

    return `
        <div class="mb-12">
            <h3 class="text-sm font-black text-stone-400 uppercase tracking-[0.3em] mb-4 border-b border-stone-100 pb-2">${title}</h3>
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-stone-50 text-[10px] uppercase tracking-widest text-stone-500 font-bold">
                        <th class="p-3">Period</th>
                        <th class="p-3">Avg Temp</th>
                        <th class="p-3">Avg Hum</th>
                        <th class="p-3">Avg Ammonia</th>
                    </tr>
                </thead>
                <tbody class="text-xs text-stone-600">
                    ${rows}
                </tbody>
            </table>
        </div>
    `;
}

function aggregateDailyAverages(logs) {
    const daily = {};

    logs.forEach(log => {
        const date = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
        if (isNaN(date.getTime())) return;

        const dKey = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;

        if (!daily[dKey]) daily[dKey] = { t: 0, h: 0, a: 0, c: 0 };
        daily[dKey].t += log.temperature || 0;
        daily[dKey].h += log.humidity || 0;
        daily[dKey].a += log.ammonia || 0;
        daily[dKey].c++;
    });

    return Object.keys(daily).map(k => ({
        label: k,
        temp: (daily[k].t / daily[k].c).toFixed(1),
        hum: (daily[k].h / daily[k].c).toFixed(1),
        amm: (daily[k].a / daily[k].c).toFixed(1)
    })).sort((a, b) => b.label.localeCompare(a.label)).slice(0, 10);
}

generateReportBtn.addEventListener('click', async () => {
    addLog("Generating comprehensive report...");
    
    // Fetch more logs for better averages
    let reportLogs = [];
    try {
        const q = query(collection(db, "sensor_logs"), orderBy("timestamp", "desc"), limit(1000));
        const querySnapshot = await getDocs(q);
        querySnapshot.forEach((doc) => {
            reportLogs.push(doc.data());
        });
    } catch (e) {
        console.error("Error fetching logs for report:", e);
        reportLogs = sensorLogs; // Fallback to current logs
    }

    const dailyAverages = aggregateDailyAverages(reportLogs);
    
    // Group logs by day for the report
    const dailyGroups = {};
    reportLogs.forEach(log => {
        if (!dailyGroups[log.dateStr]) dailyGroups[log.dateStr] = [];
        dailyGroups[log.dateStr].push(log);
    });

    const sortedDates = Object.keys(dailyGroups).sort((a, b) => new Date(b) - new Date(a));

    let dailySectionsHtml = sortedDates.map(date => {
        const logs = dailyGroups[date];
        const sum = logs.reduce((acc, curr) => ({
            t: acc.t + (curr.temperature || 0),
            h: acc.h + (curr.humidity || 0),
            a: acc.a + (curr.ammonia || 0)
        }), { t: 0, h: 0, a: 0 });
        const count = logs.length;
        
        const rows = logs.map(row => `
            <tr class="border-b border-stone-100">
                <td class="p-2">${row.timeStr}</td>
                <td class="p-2">${(row.temperature || 0).toFixed(1)}°C</td>
                <td class="p-2">${(row.humidity || 0).toFixed(1)}%</td>
                <td class="p-2">${(row.ammonia || 0).toFixed(0)}</td>
            </tr>
        `).join('');

        return `
            <div class="mb-12 page-break-before">
                <div class="flex items-center justify-between mb-4 border-b-2 border-stone-900 pb-2">
                    <h3 class="text-xl font-black text-stone-900 uppercase tracking-widest">Daily Log: ${date}</h3>
                    <div class="flex gap-4 text-[10px] font-bold text-emerald-700 uppercase">
                        <span>Avg Temp: ${(sum.t / count).toFixed(1)}°C</span>
                        <span>Avg Hum: ${(sum.h / count).toFixed(1)}%</span>
                        <span>Avg Amm: ${(sum.a / count).toFixed(0)}</span>
                    </div>
                </div>
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-stone-50 text-[10px] uppercase tracking-widest text-stone-500 font-bold">
                            <th class="p-2">Time</th>
                            <th class="p-2">Temp</th>
                            <th class="p-2">Hum</th>
                            <th class="p-2">Ammonia</th>
                        </tr>
                    </thead>
                    <tbody class="text-xs text-stone-600">
                        ${rows}
                    </tbody>
                </table>
            </div>
        `;
    }).join('');

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
            <head>
                <title>Smart Quail Farm - Comprehensive Report</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    @media print {
                        .no-print { display: none; }
                        body { padding: 0; }
                        .page-break-before { page-break-before: always; }
                    }
                    table { page-break-inside: auto; }
                    tr { page-break-inside: avoid; page-break-after: auto; }
                    thead { display: table-header-group; }
                </style>
            </head>
            <body class="p-10 font-sans bg-white">
                <div class="max-w-4xl mx-auto">
                    <div class="flex justify-between items-center mb-8 border-b-2 border-stone-800 pb-6">
                        <div>
                            <h1 class="text-4xl font-black text-stone-900 tracking-tighter uppercase">Smart Quail Farm</h1>
                            <p class="text-stone-500 font-bold tracking-[0.2em] text-xs mt-1">Automated Environmental Monitoring System</p>
                        </div>
                        <div class="text-right">
                            <p class="text-stone-900 font-black text-xl">${new Date().toLocaleDateString()}</p>
                            <p class="text-stone-500 text-xs font-bold uppercase tracking-widest">${new Date().toLocaleTimeString()}</p>
                        </div>
                    </div>

                    <div class="mb-12">
                        <h2 class="text-xl font-black text-stone-900 mb-8 uppercase tracking-widest border-l-8 border-stone-900 pl-4">Daily Averages Summary</h2>
                        ${formatAverageTable('Last 10 Days', dailyAverages)}
                    </div>
                    
                    <h2 class="text-xl font-black text-stone-900 mb-8 uppercase tracking-widest border-l-8 border-stone-900 pl-4">Daily Sensor Logs</h2>
                    ${dailySectionsHtml}

                    <div class="grid grid-cols-2 gap-8 mt-12 pt-8 border-t border-stone-100">
                        <div>
                            <p class="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Prepared By</p>
                            <div class="h-12 border-b border-stone-300 w-48"></div>
                            <p class="text-xs font-bold text-stone-800 mt-2">Farm Administrator</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Verified By</p>
                            <div class="h-12 border-b border-stone-300 w-48 ml-auto"></div>
                            <p class="text-xs font-bold text-stone-800 mt-2">Technical Supervisor</p>
                        </div>
                    </div>
                    
                    <div class="mt-16 text-center no-print">
                        <button onclick="window.print()" class="bg-stone-900 text-white px-10 py-4 rounded-full font-black uppercase tracking-widest text-xs hover:bg-stone-800 transition-all shadow-xl hover:shadow-2xl active:scale-95">
                            Print Official Report
                        </button>
                    </div>
                </div>
            </body>
        </html>
    `);
    printWindow.document.close();
});

// --- Authentication Logic ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        userDisplayName.textContent = user.email.split('@')[0];
        authOverlay.classList.add('hidden');
        showDashboard();
    } else {
        currentUser = null;
        showAuthOverlay();
        stopPolling();
    }
});

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = authEmail.value;
    const password = authPassword.value;

    try {
        if (isAuthModeLogin) {
            await signInWithEmailAndPassword(auth, email, password);
            addLog("Logged in successfully.");
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
            addLog("Account created and logged in.");
        }
    } catch (error) {
        console.error("Auth error:", error);
        alert(error.message);
        addLog(`Auth Error: ${error.message}`);
    }
}

function toggleAuthMode() {
    isAuthModeLogin = !isAuthModeLogin;
    authSubtitle.textContent = isAuthModeLogin ? "Sign in to your dashboard" : "Create a new account";
    authSubmitBtn.textContent = isAuthModeLogin ? "Sign In" : "Register";
    toggleAuthModeBtn.textContent = isAuthModeLogin ? "Don't have an account? Register" : "Already have an account? Login";
}

async function handleLogout() {
    try {
        await signOut(auth);
        location.reload();
    } catch (error) {
        addLog(`Logout Error: ${error.message}`);
    }
}

// --- UI Navigation ---

function showAuthOverlay() {
    authOverlay.classList.remove('hidden');
    dashboard.classList.add('hidden');
}

function showDashboard() {
    authOverlay.classList.add('hidden');
    dashboard.classList.remove('hidden');
    renderHistory();
    initChart();
    startPolling();
    startHourlyLogging();
    syncHistoryWithServer();
    checkNotificationPermission();
    updateAutoModeUI();
}

// --- Blynk API Integration ---

async function fetchBlynkData() {
    // We fetch pins in a way that handles potential missing pins in the template
    const sensorPins = ['V0', 'V1', 'V2', 'V3'];
    const actuatorPins = ['V10', 'V11', 'V12', 'V13', 'V4', 'V5'];
    const schedulePins = ['V20', 'V21', 'V22', 'V23', 'V24', 'V25'];
    const allPins = [...sensorPins, ...actuatorPins, ...schedulePins];

    try {
        // Try batch fetch first
        const url = `${blynkConfig.baseUrl}/get?${allPins.join('&')}`;
        const response = await fetch(url);
        
        if (response.ok) {
            const data = await response.json();
            updateState(data);
            updateStatus(true);
        } else {
            // If batch fails (likely due to missing pins or 400 error), fetch individually
            const errorText = await response.text();
            console.warn("Batch fetch failed, attempting individual pin updates:", errorText);
            
            let successAny = false;
            for (const pin of allPins) {
                try {
                    const pUrl = `${blynkConfig.baseUrl}/get?${pin}`;
                    const pRes = await fetch(pUrl);
                    if (pRes.ok) {
                        const val = await pRes.text();
                        const update = {};
                        update[pin] = val;
                        updateState(update);
                        successAny = true;
                    }
                } catch (e) {
                    // Skip pins that don't exist
                }
            }
            updateStatus(successAny);
        }
    } catch (error) {
        console.error("Fetch error:", error);
        updateStatus(false);
        // Only log to terminal if it's a new error to avoid spam
        if (farmState.isOnline) {
            addLog(`Blynk Connection Error: ${error.message}`, "error");
        }
    }
}

async function updateBlynkPin(pin, value) {
    const pinKey = pin.toLowerCase();
    
    // Set manual override flag to prevent polling from flickering the UI
    manualOverrides[pinKey] = Date.now() + 10000; // Ignore polling for 10 seconds

    const url = `${blynkConfig.baseUrl}/update?${pin}=${value}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Update failed");
        }
        addLog(`Updated ${pin} to ${value}`);
        farmState[pinKey] = value;
        renderActuators();
        return true;
    } catch (error) {
        addLog(`Update Error (${pin}): ${error.message}`, "error");
        delete manualOverrides[pinKey];
        return false;
    }
}

async function saveSettings() {
    const feedTime = document.getElementById('feed-time').value;
    const feedDur = document.getElementById('feed-duration').value;
    const cleanTime = document.getElementById('cleaner-time').value;
    const cleanDur = document.getElementById('cleaner-duration').value;
    const lightStart = document.getElementById('light-start').value;
    const lightEnd = document.getElementById('light-end').value;

    const timeToMins = (t) => {
        if (!t) return 0;
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    };

    addLog("Saving settings to ESP32...");
    
    const settings = {
        'V20': feedDur,
        'V21': timeToMins(feedTime),
        'V22': cleanDur,
        'V23': timeToMins(cleanTime),
        'V24': timeToMins(lightStart),
        'V25': timeToMins(lightEnd)
    };

    let successCount = 0;
    let failCount = 0;

    for (const [pin, val] of Object.entries(settings)) {
        try {
            const url = `${blynkConfig.baseUrl}/update?${pin}=${val}`;
            const response = await fetch(url);
            if (!response.ok) {
                const errText = await response.text();
                if (errText.includes("doesn't exist")) {
                    console.warn(`Pin ${pin} not found in Blynk template.`);
                } else {
                    throw new Error(errText);
                }
                failCount++;
            } else {
                successCount++;
            }
        } catch (e) {
            console.error(`Error saving ${pin}:`, e);
            failCount++;
        }
    }

    if (successCount > 0) {
        addLog(`Settings saved (${successCount} pins updated).`);
        
        // Update local state
        farmState.v20 = parseFloat(feedDur);
        farmState.v21 = timeToMins(feedTime);
        farmState.v22 = parseFloat(cleanDur);
        farmState.v23 = timeToMins(cleanTime);
        farmState.v24 = timeToMins(lightStart);
        farmState.v25 = timeToMins(lightEnd);

        if (failCount > 0) {
            addLog(`${failCount} pins missing in Blynk template.`, "warn");
        }
    } else {
        addLog("Failed to save settings. Check backend configuration.", "error");
    }
}

// --- Dashboard Logic ---

function updateState(data) {
    const now = Date.now();
    console.log("Updating state with data:", data);
    Object.keys(data).forEach(pin => {
        const val = parseFloat(data[pin]);
        const pinKey = pin.toLowerCase();
        
        // Skip if this pin is currently under manual override
        if (manualOverrides[pinKey] && now < manualOverrides[pinKey]) {
            return;
        }

        if (farmState[pinKey] !== val) {
            const oldVal = farmState[pinKey];
            farmState[pinKey] = val;
            
            if (pinKey === 'v5') {
                const isAuto = val === 1;
                if (farmState.isAutoMode !== isAuto) {
                    farmState.isAutoMode = isAuto;
                    localStorage.setItem('auto_mode', isAuto);
                    updateAutoModeUI();
                    renderActuators();
                    addLog(`Auto Mode synced from server: ${isAuto ? 'ON' : 'OFF'}`);
                }
            }

            if (['v10', 'v11', 'v12', 'v13', 'v4'].includes(pinKey)) {
                const name = getActuatorName(pinKey);
                addLog(`${name} turned ${val ? 'ON' : 'OFF'}`);
            }

            runAutomationLogic(pinKey, val);
        }
    });

    renderSensors();
    renderActuators();
    updateScheduleUI();
}

function runAutomationLogic(pin, val) {
    // Automation logic only runs if Auto Mode is ON
    if (!farmState.isAutoMode) return;

    // Fan ON if temp > 27°C, OFF ≤ 25°C
    if (pin === 'v0') {
        if (val > 27 && farmState.v10 === 0) {
            addLog('Auto-trigger: Temperature high (>27°C). Turning Fan ON.');
            updateBlynkPin('V10', 1);
            sendNotification('High Temperature Alert', `Temp is ${val}°C. Fan activated.`);
        } else if (val <= 25 && farmState.v10 === 1) {
            addLog('Auto-trigger: Temperature stabilized (≤25°C). Turning Fan OFF.');
            updateBlynkPin('V10', 0);
        }
    }

    // Heater ON ≤ 18°C, OFF ≥ 25°C
    if (pin === 'v0') {
        if (val <= 18 && farmState.v11 === 0) {
            addLog('Auto-trigger: Temperature low (≤18°C). Turning Heater ON.');
            updateBlynkPin('V11', 1);
            sendNotification('Low Temperature Alert', `Temp is ${val}°C. Heater activated.`);
        } else if (val >= 25 && farmState.v11 === 1) {
            addLog('Auto-trigger: Temperature stabilized (≥25°C). Turning Heater OFF.');
            updateBlynkPin('V11', 0);
        }
    }

    // Stool Cleaner auto if Ammonia Raw ≥ 1500
    if (pin === 'v2') {
        if (val >= 1500 && farmState.v13 === 0) {
            addLog('Auto-trigger: High Ammonia Raw (≥1500). Starting Stool Cleaner.');
            updateBlynkPin('V13', 1);
            sendNotification('Ammonia Warning', `Raw level at ${val}. Cleaning started.`);
            
            setTimeout(() => {
                addLog('Stool Cleaner cycle complete (20s). Turning OFF.');
                updateBlynkPin('V13', 0);
            }, 20000);
        }
    }
}

function renderSensors() {
    // Temp (V0)
    const temp = farmState.v0;
    let tempStatus = 'critical';
    if (temp >= 21 && temp <= 24) tempStatus = 'optimal';
    else if ((temp >= 18 && temp < 21) || (temp > 24 && temp <= 27)) tempStatus = 'warning';
    updateCardStatus('v0', tempStatus, tempStatus === 'optimal' ? '✅ Optimal' : tempStatus === 'warning' ? '⚠️ Warning' : '🚨 Critical');

    // Humidity (V1)
    const hum = farmState.v1;
    let humStatus = 'critical';
    if (hum >= 40 && hum <= 70) humStatus = 'optimal';
    else if ((hum >= 35 && hum < 40) || (hum > 70 && hum <= 75)) humStatus = 'warning';
    updateCardStatus('v1', humStatus, humStatus === 'optimal' ? '✅ Optimal' : humStatus === 'warning' ? '⚠️ Warning' : '🚨 Critical');

    // Ammonia Raw (V2)
    const amm = farmState.v2;
    let ammStatus = 'critical';
    if (amm < 900) ammStatus = 'optimal';
    else if (amm >= 900 && amm <= 1500) ammStatus = 'warning';
    updateCardStatus('v2', ammStatus, ammStatus === 'optimal' ? '✅ Optimal' : ammStatus === 'warning' ? '⚠️ Warning' : '🚨 Critical');

    // Feed Level (V3)
    const feed = farmState.v3;
    const empty = CALIBRATION.V3_EMPTY;
    const full = CALIBRATION.V3_FULL;
    const feedPct = Math.max(0, Math.min(100, ((feed - empty) / (full - empty)) * 100));
    
    let feedStatus = 'critical';
    if (feedPct > 20) feedStatus = 'optimal';
    else if (feedPct >= 10 && feedPct <= 20) feedStatus = 'warning';
    updateCardStatus('v3', feedStatus, feedStatus === 'optimal' ? '✅ Optimal' : feedStatus === 'warning' ? '⚠️ Warning' : '🚨 Critical');

    updateSensorUI('v0', farmState.v0, 50);
    updateSensorUI('v1', farmState.v1, 100);
    updateSensorUI('v2', farmState.v2, 4095);
    updateSensorUI('v3', farmState.v3, 100);
}

function updateCardStatus(pin, status, text) {
    const card = document.getElementById(`card-${pin}`);
    const note = document.getElementById(`note-${pin}`);
    const val = document.getElementById(`val-${pin}`);

    if (!card || !val) return;

    // Reset styles to neutral
    if (note) {
        note.className = "text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-widest bg-stone-100 text-stone-400";
        note.textContent = text;
    }
    val.className = "text-5xl font-bold text-stone-800 transition-colors";

    if (status === 'optimal') {
        val.classList.replace('text-stone-800', 'text-emerald-500');
        if (note) {
            note.classList.replace('bg-stone-100', 'bg-emerald-50');
            note.classList.replace('text-stone-400', 'text-emerald-600');
        }
    } else if (status === 'warning') {
        val.classList.replace('text-stone-800', 'text-amber-500');
        if (note) {
            note.classList.replace('bg-stone-100', 'bg-amber-50');
            note.classList.replace('text-stone-400', 'text-amber-600');
        }
    } else if (status === 'critical') {
        val.classList.replace('text-stone-800', 'text-red-500');
        if (note) {
            note.classList.replace('bg-stone-100', 'bg-red-50');
            note.classList.replace('text-stone-400', 'text-red-600');
        }
    }
}

function setNote(el, text, classes) {
    if (!el) return;
    el.textContent = text;
    el.className = `text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-widest ${classes}`;
}

function updateSensorUI(id, val, max) {
    const el = document.getElementById(`val-${id}`);
    const bar = document.getElementById(`bar-${id}`);
    
    let displayVal = val;
    let pct = Math.min((val / max) * 100, 100);

    // Calibration logic for Feed Level (V3)
    if (id === 'v3') {
        const empty = CALIBRATION.V3_EMPTY;
        const full = CALIBRATION.V3_FULL;
        
        // Calculate percentage based on direct mapping
        // (val - empty) / (full - empty) * 100
        let calculatedPct = ((val - empty) / (full - empty)) * 100;
        
        pct = Math.max(0, Math.min(100, calculatedPct));
        displayVal = Math.round(pct);

        if (el) el.innerText = `${displayVal}%`;
    } else {
        if (el) el.innerText = displayVal;
    }
    if (bar) {
        bar.style.width = `${pct}%`;
    }
}

function renderActuators() {
    ['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
        const btn = document.getElementById(`btn-${pin}`);
        const dot = btn.querySelector('.dot');
        
        if (farmState.isAutoMode) {
            btn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }

        if (farmState[pin] === 1) {
            btn.classList.remove('bg-stone-300');
            btn.classList.add('bg-emerald-500');
            dot.classList.add('translate-x-6');
        } else {
            btn.classList.add('bg-stone-300');
            btn.classList.remove('bg-emerald-500');
            dot.classList.remove('translate-x-6');
        }
    });
}

function updateScheduleUI() {
    const minsToTime = (m) => {
        const h = Math.floor(m / 60).toString().padStart(2, '0');
        const min = (m % 60).toString().padStart(2, '0');
        return `${h}:${min}`;
    };

    const setIfNoFocus = (id, val) => {
        const el = document.getElementById(id);
        if (el && !el.matches(':focus')) el.value = val;
    };

    setIfNoFocus('feed-time', minsToTime(farmState.v21));
    setIfNoFocus('feed-duration', farmState.v20);
    setIfNoFocus('cleaner-time', minsToTime(farmState.v23));
    setIfNoFocus('cleaner-duration', farmState.v22);
    setIfNoFocus('light-start', minsToTime(farmState.v24));
    setIfNoFocus('light-end', minsToTime(farmState.v25));
}

function updateStatus(online) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (online) {
        dot.classList.replace('bg-stone-300', 'bg-emerald-500');
        dot.classList.remove('bg-red-500');
        text.textContent = "Online";
        text.classList.replace('text-stone-500', 'text-emerald-600');
        text.classList.remove('text-red-500');
        if (!farmState.isOnline) {
            addLog("ESP32 is ONLINE.");
            sendNotification('System Status', 'Quail Farm ESP32 is now online.');
        }
    } else {
        dot.classList.replace('bg-emerald-500', 'bg-red-500');
        text.textContent = "Offline / Error";
        text.classList.replace('text-emerald-600', 'text-red-500');
        if (farmState.isOnline) {
            addLog("ESP32 is OFFLINE!", "error");
            sendNotification('System Status', 'ALERT: Quail Farm ESP32 went offline.');
        }
    }
    farmState.isOnline = online;
}

function addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const entry = document.createElement('div');
    let colorClass = 'text-stone-400';
    if (type === 'error') colorClass = 'text-red-400';
    entry.innerHTML = `<span class="text-stone-600">[${time}]</span> <span class="${colorClass}">${message}</span>`;
    terminalLog.appendChild(entry);
    terminalLog.scrollTop = terminalLog.scrollHeight;
}

function renderHistory() {
    const tbody = document.getElementById('history-table');
    const tabsContainer = document.getElementById('history-tabs');
    const avgBanner = document.getElementById('daily-average-banner');
    const avgTempVal = document.getElementById('avg-temp-val');
    const avgHumVal = document.getElementById('avg-hum-val');
    const avgAmmVal = document.getElementById('avg-amm-val');
    
    if (!tbody || !tabsContainer) return;

    // Group logs by date
    const groupedLogs = {};
    sensorLogs.forEach(log => {
        if (!groupedLogs[log.dateStr]) {
            groupedLogs[log.dateStr] = [];
        }
        groupedLogs[log.dateStr].push(log);
    });

    const dates = Object.keys(groupedLogs).sort((a, b) => new Date(b) - new Date(a));
    
    if (dates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-10 text-center text-stone-400 italic">No sensor data available.</td></tr>';
        tabsContainer.innerHTML = '';
        avgBanner.classList.add('hidden');
        return;
    }

    // Set default selected date if none or if current selected date no longer exists
    if (!selectedHistoryDate || !groupedLogs[selectedHistoryDate]) {
        selectedHistoryDate = dates[0];
    }

    // Render Tabs
    tabsContainer.innerHTML = dates.map(date => `
        <button onclick="window.setHistoryDate('${date}')" 
            class="px-4 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-all ${selectedHistoryDate === date ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-200' : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}">
            ${date}
        </button>
    `).join('');

    // Filter logs for selected date
    const logsForDate = groupedLogs[selectedHistoryDate] || [];
    
    // Calculate Averages for the selected date
    if (logsForDate.length > 0) {
        const sum = logsForDate.reduce((acc, curr) => ({
            t: acc.t + (curr.temperature || 0),
            h: acc.h + (curr.humidity || 0),
            a: acc.a + (curr.ammonia || 0)
        }), { t: 0, h: 0, a: 0 });
        
        const count = logsForDate.length;
        avgTempVal.textContent = `${(sum.t / count).toFixed(1)}°C`;
        avgHumVal.textContent = `${(sum.h / count).toFixed(1)}%`;
        avgAmmVal.textContent = (sum.a / count).toFixed(0);
        avgBanner.classList.remove('hidden');
    } else {
        avgBanner.classList.add('hidden');
    }

    // Render Table (No Feed Column)
    tbody.innerHTML = logsForDate.map(row => `
        <tr class="border-b border-stone-50 hover:bg-stone-50 transition-colors">
            <td class="py-3 font-medium">${row.timeStr}</td>
            <td class="py-3">${(row.temperature || 0).toFixed(1)}°C</td>
            <td class="py-3">${(row.humidity || 0).toFixed(1)}%</td>
            <td class="py-3">${(row.ammonia || 0).toFixed(0)}</td>
        </tr>
    `).join('');
}

// Expose to window for onclick
window.setHistoryDate = (date) => {
    selectedHistoryDate = date;
    renderHistory();
};

function initChart() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            y: { beginAtZero: true, grid: { color: '#f5f5f4' } },
            x: { grid: { display: false } }
        }
    };

    const labels = hourlyData.map(d => d.time);

    const tempCtx = document.getElementById('tempChart');
    if (tempCtx) {
        tempChart = new Chart(tempCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Temp', data: hourlyData.map(d => d.temp), borderColor: '#f97316', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const humCtx = document.getElementById('humChart');
    if (humCtx) {
        humChart = new Chart(humCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Hum', data: hourlyData.map(d => d.hum), borderColor: '#3b82f6', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const ammCtx = document.getElementById('ammChart');
    if (ammCtx) {
        ammChart = new Chart(ammCtx.getContext('2d'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Amm', data: hourlyData.map(d => d.amm), borderColor: '#a855f7', tension: 0.4, pointRadius: 2 }] },
            options: commonOptions
        });
    }

    const eggsCtx = document.getElementById('eggsChart');
    if (eggsCtx) {
        eggsChart = new Chart(eggsCtx.getContext('2d'), {
            type: 'line', // Changed back to line as requested
            data: { 
                labels: farmHistory.map(h => h.date.split('-').slice(1).join('/')), // Show MM/DD
                datasets: [{ 
                    label: 'Eggs', 
                    data: farmHistory.map(h => h.eggs), 
                    borderColor: '#10b981', 
                    tension: 0.4,
                    pointRadius: 3,
                    fill: false
                }] 
            },
            options: commonOptions
        });
    }
}

function updateChart() {
    if (!tempChart || !humChart || !ammChart || !eggsChart) return;
    const labels = hourlyData.map(d => d.time);

    [tempChart, humChart, ammChart].forEach(chart => {
        chart.data.labels = labels;
    });

    tempChart.data.datasets[0].data = hourlyData.map(d => d.temp);
    humChart.data.datasets[0].data = hourlyData.map(d => d.hum);
    ammChart.data.datasets[0].data = hourlyData.map(d => d.amm);

    // Update Eggs Chart (Daily)
    eggsChart.data.labels = farmHistory.map(h => h.date.split('-').slice(1).join('/'));
    eggsChart.data.datasets[0].data = farmHistory.map(h => h.eggs);

    [tempChart, humChart, ammChart, eggsChart].forEach(chart => chart.update());
}

function startHourlyLogging() {
    if (hourlyTimer) clearInterval(hourlyTimer);
    
    // Log immediately if empty
    if (hourlyData.length === 0) logHourlyData();

    // Check every minute if an hour has passed
    hourlyTimer = setInterval(() => {
        const now = new Date();
        if (now.getMinutes() === 0) {
            logHourlyData();
        }
    }, 60000);
}

function logHourlyData() {
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ":00";
    const dateStr = now.toISOString().split('T')[0];

    const todayEggs = farmHistory.find(h => h.date === dateStr)?.eggs || 0;

    const entry = {
        time: timeStr,
        date: dateStr,
        temp: farmState.v0,
        hum: farmState.v1,
        amm: farmState.v2,
        eggs: todayEggs,
        timestamp: now.getTime()
    };

    hourlyData.push(entry);
    
    // Keep only last 24 hours for the graph
    if (hourlyData.length > 24) {
        // Before removing, if it's the end of the day, aggregate it
        const lastDate = hourlyData[0].date;
        if (dateStr !== lastDate) {
            aggregateDailyData(lastDate);
        }
        hourlyData.shift();
    }

    localStorage.setItem('hourly_data', JSON.stringify(hourlyData));
    updateChart();
}

function aggregateDailyData(date) {
    const dayEntries = hourlyData.filter(d => d.date === date);
    if (dayEntries.length === 0) return;

    const avgTemp = dayEntries.reduce((acc, curr) => acc + curr.temp, 0) / dayEntries.length;
    const avgHum = dayEntries.reduce((acc, curr) => acc + curr.hum, 0) / dayEntries.length;
    const avgAmm = dayEntries.reduce((acc, curr) => acc + curr.amm, 0) / dayEntries.length;
    const eggs = dayEntries[dayEntries.length - 1].eggs;

    const existingIndex = farmHistory.findIndex(h => h.date === date);
    const newEntry = { date, avgTemp, avgHum, avgAmmonia: avgAmm, eggs };

    if (existingIndex >= 0) {
        farmHistory[existingIndex] = newEntry;
    } else {
        farmHistory.unshift(newEntry);
    }

    localStorage.setItem('farm_history', JSON.stringify(farmHistory));
    renderHistory();
    addLog(`Daily summary for ${date} generated.`);
}

function logEggs() {
    const count = prompt('Enter number of eggs collected today:');
    if (count !== null && !isNaN(count)) {
        const today = new Date().toISOString().split('T')[0];
        const existing = farmHistory.find(h => h.date === today);
        if (existing) {
            existing.eggs = parseInt(count);
        } else {
            farmHistory.unshift({
                date: today,
                avgTemp: farmState.v0 || 25,
                avgHum: farmState.v1 || 65,
                avgAmmonia: farmState.v2 || 2,
                eggs: parseInt(count)
            });
        }
        localStorage.setItem('farm_history', JSON.stringify(farmHistory));
        renderHistory();
        updateChart();
        addLog(`Logged ${count} eggs for ${today}.`);
    }
}

function editEggLog() {
    const today = new Date().toISOString().split('T')[0];
    const existing = farmHistory.find(h => h.date === today);
    
    if (!existing) {
        addLog("No egg log found for today. Use 'Log Eggs' first.", "warn");
        return;
    }

    const newCount = prompt(`Edit eggs for today (${today}):`, existing.eggs);
    if (newCount !== null && !isNaN(newCount)) {
        existing.eggs = parseInt(newCount);
        localStorage.setItem('farm_history', JSON.stringify(farmHistory));
        renderHistory();
        updateChart();
        addLog(`Updated today's eggs to ${newCount}.`);
    }
}

function toggleAutoMode() {
    farmState.isAutoMode = !farmState.isAutoMode;
    localStorage.setItem('auto_mode', farmState.isAutoMode);
    
    // Sync Auto Mode state with Blynk (V5)
    updateBlynkPin('V5', farmState.isAutoMode ? 1 : 0);
    
    updateAutoModeUI();
    renderActuators();
    addLog(`Automatic Mode turned ${farmState.isAutoMode ? 'ON' : 'OFF'}`);
}

function updateAutoModeUI() {
    const dot = autoModeToggle.querySelector('.dot');
    if (farmState.isAutoMode) {
        autoModeToggle.classList.replace('bg-stone-300', 'bg-emerald-500');
        dot.classList.add('translate-x-6');
    } else {
        autoModeToggle.classList.replace('bg-emerald-500', 'bg-stone-300');
        dot.classList.remove('translate-x-6');
    }
}

function showBrowserNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
    }
}

async function sendNotification(title, body) {
    if (currentUser) {
        try {
            await addDoc(collection(db, "notifications"), {
                title,
                body,
                timestamp: serverTimestamp(),
                userId: currentUser.uid,
                read: false
            });
        } catch (e) {
            console.error("Error saving notification to Firestore:", e);
        }
    }
}

function checkNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        enableNotifsBtn.classList.remove('hidden');
    } else {
        enableNotifsBtn.classList.add('hidden');
    }
}

function getActuatorName(pin) {
    const names = { v10: 'Fan', v11: 'Heater', v12: 'Light', v13: 'Cleaner', v4: 'Feed' };
    return names[pin] || pin.toUpperCase();
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (firebaseLogTimer) clearInterval(firebaseLogTimer);
    
    // Initial fetch and wait for it to complete before logging
    await fetchBlynkData();
    
    pollTimer = setInterval(fetchBlynkData, blynkConfig.pollInterval);
    
    // Initial sync with Firestore
    syncHistoryWithServer();

    // Log to Firebase immediately on startup (now that we have data)
    // This will be caught by the cooldown if it's too soon
    logToFirebase();

    // Align hourly logging to the top of the hour
    const now = new Date();
    const msToNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
    
    setTimeout(() => {
        logToFirebase(); // Log at the top of the hour
        firebaseLogTimer = setInterval(() => {
            logToFirebase();
        }, 60 * 60 * 1000);
    }, msToNextHour);
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (firebaseLogTimer) clearInterval(firebaseLogTimer);
}

// --- Event Listeners ---

authForm.addEventListener('submit', handleAuthSubmit);
toggleAuthModeBtn.addEventListener('click', toggleAuthMode);
logoutBtn.addEventListener('click', handleLogout);
if (logoutBtnMenu) logoutBtnMenu.addEventListener('click', handleLogout);
autoModeToggle.addEventListener('click', toggleAutoMode);

['v10', 'v11', 'v12', 'v13', 'v4'].forEach(pin => {
    document.getElementById(`btn-${pin}`).addEventListener('click', function() {
        if (farmState.isAutoMode) {
            addLog("Manual control is disabled while Auto Mode is ON.", "warn");
            return;
        }

        const isActive = farmState[pin] === 1;
        const targetVal = isActive ? 0 : 1;

        updateBlynkPin(pin.toUpperCase(), targetVal);
        
        // For V4 (Feed), auto-off after 3 seconds in the UI for better feedback
        if (pin === 'v4' && targetVal === 1) {
            addLog("Feeding started...");
            setTimeout(() => {
                if (farmState.v4 === 1) {
                    updateBlynkPin('V4', 0);
                }
            }, 3000);
        }
    });
});

document.getElementById('save-settings').addEventListener('click', saveSettings);

profileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => {
    profileMenu.classList.add('hidden');
});

profileMenu.addEventListener('click', (e) => {
    e.stopPropagation();
});

document.getElementById('clear-log').addEventListener('click', () => {
    terminalLog.innerHTML = '';
    addLog("Terminal cleared.");
});

enableNotifsBtn.addEventListener('click', () => {
    Notification.requestPermission().then(permission => {
        if (permission === "granted") {
            enableNotifsBtn.classList.add('hidden');
            addLog("Notifications enabled.");
        }
    });
});

setInterval(() => {
    const now = new Date();
    currentTimeDisplay.textContent = now.toLocaleTimeString([], { hour12: false });
    currentDateDisplay.textContent = now.toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
}, 1000);
